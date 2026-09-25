import OpenAI from 'openai';
import {
  OPENROUTER_BASE_URL,
  getOpenRouterHeaders,
  toOpenRouterModelId
} from './ai-provider';

/**
 * Looks at an image and decides whether it contains text worth translating.
 *
 * This is the only part of the pipeline that calls a model. The question is
 * narrow on purpose: a diagram labelled "1 2 3 4" needs no translation, while
 * one labelled "печень / желудок" does. Getting that distinction right is what
 * decides whether a question survives the filter.
 */

export type ImageTextKind =
  /** Contains at least one real word in some language - translatable. */
  | 'words'
  /** Only digits, formulas or isolated letters used as labels - not translatable. */
  | 'numeric'
  /** No readable text at all. */
  | 'none';

/**
 * Language of the words found, as an ISO 639-1 code.
 *
 * Only the languages this project deals with are named; anything else is
 * `other`, and `none` means there were no words to judge. Knowing this lets a
 * run keep, say, only the Russian images - the rest have nothing to translate
 * into the target language.
 */
export type ImageTextLanguage = 'ru' | 'az' | 'en' | 'tr' | 'other' | 'none';

export const IMAGE_TEXT_LANGUAGES: Array<{ code: ImageTextLanguage; name: string }> = [
  { code: 'ru', name: 'Russian' },
  { code: 'az', name: 'Azerbaijani' },
  { code: 'en', name: 'English' },
  { code: 'tr', name: 'Turkish' }
];

export interface ImageTextResult {
  kind: ImageTextKind;
  /** Which language the words are in. `none` when there are no words. */
  language: ImageTextLanguage;
  /** A short excerpt of what the model read, for spot-checking its decision. */
  sample: string;
}

const PROMPT = `You are inspecting one image taken from an exam question.

Decide whether it contains TRANSLATABLE TEXT - words in a human language that
would have to be translated if this exam were republished in another language.

Choose exactly one kind:

"words"   - the image contains at least one real word in any language or script
            (for example: "печень", "Blatt", "cell membrane", "şəkil").
            Choose this if there is even one real word, even alongside numbers.

"numeric" - the image contains readable characters, but only digits, arithmetic
            or chemical formulas, units, or isolated letters used as labels or
            variables. Examples: "1 2 3 4", "A B C", "n/2", "H2O", "6.02x10^23",
            "x + y = 5". Nothing here needs translating.

"none"    - no readable text at all: a plain drawing, diagram, photo or graph
            with no labels.

When the kind is "words", also report which language those words are in:
"ru" Russian, "az" Azerbaijani, "en" English, "tr" Turkish, or "other" for any
other language. Judge by the words themselves, not by the alphabet alone -
Azerbaijani and Turkish both use Latin letters, Russian uses Cyrillic.
When the kind is "numeric" or "none", the language is "none".

Return ONLY a JSON object, no commentary. Keep "sample" empty or very short
(ASCII only, no quotes) so the JSON never breaks:
{"kind":"words"|"numeric"|"none","language":"ru"|"az"|"en"|"tr"|"other"|"none","sample":""}`;

const KNOWN_LANGUAGES: ImageTextLanguage[] = ['ru', 'az', 'en', 'tr', 'other', 'none'];

/** How many images may be classified at once. Vision calls are network-bound. */
export function getImageAnalysisConcurrency(): number {
  const fromEnv = parseInt(process.env.IMAGE_ANALYSIS_CONCURRENCY || '', 10);
  if (Number.isFinite(fromEnv) && fromEnv >= 1) return Math.min(fromEnv, 16);
  return 4;
}

export function createVisionClient(apiKey: string): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: getOpenRouterHeaders()
  });
}

function normalizeResult(
  kindRaw: string | undefined,
  languageRaw: string | undefined,
  sampleRaw: unknown
): ImageTextResult {
  const kind: ImageTextKind =
    kindRaw === 'words' || kindRaw === 'numeric' || kindRaw === 'none'
      ? kindRaw
      : 'none';

  let language: ImageTextLanguage =
    KNOWN_LANGUAGES.includes(languageRaw as ImageTextLanguage)
      ? (languageRaw as ImageTextLanguage)
      : 'other';
  if (kind !== 'words') language = 'none';

  return {
    kind,
    language,
    sample: typeof sampleRaw === 'string' ? sampleRaw.slice(0, 60) : ''
  };
}

/**
 * Parses the model reply. Large runs used to treat every broken JSON sample
 * (unescaped quotes, truncated strings) as "no text", which silently deleted
 * good questions. We try JSON first, then fall back to field regexes.
 */
export function parseResult(raw: string): ImageTextResult {
  let text = raw.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }
  if (!text.startsWith('{')) {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) text = match[0];
  }

  try {
    const parsed = JSON.parse(text) as {
      kind?: string;
      language?: string;
      sample?: string;
    };
    return normalizeResult(parsed.kind, parsed.language, parsed.sample);
  } catch {
    // Sample fields often contain unescaped quotes and break JSON.parse.
    // Pull the two fields that actually drive filtering.
    const kindMatch = text.match(/"kind"\s*:\s*"(words|numeric|none)"/i);
    const languageMatch = text.match(
      /"language"\s*:\s*"(ru|az|en|tr|other|none)"/i
    );
    if (kindMatch) {
      return normalizeResult(
        kindMatch[1].toLowerCase(),
        languageMatch?.[1]?.toLowerCase(),
        ''
      );
    }
    throw new Error(`Could not parse vision response: ${text.slice(0, 120)}`);
  }
}

async function classifyOnce(
  dataUrl: string,
  client: OpenAI,
  model: string
): Promise<ImageTextResult> {
  const response = await client.chat.completions.create({
    model: toOpenRouterModelId(model),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }
    ],
    response_format: { type: 'json_object' },
    // Short reply only — long "sample" strings were truncating and breaking JSON.
    max_tokens: 80,
    temperature: 0
  });

  const raw = response.choices[0]?.message?.content?.trim() || '';
  if (!raw) throw new Error('Empty response from the vision model');
  return parseResult(raw);
}

/**
 * Classifies a single image given as a `data:image/...;base64,...` URL.
 *
 * Throws on API failure; the caller decides what an unclassifiable image means.
 * One automatic retry covers flaky truncations on long runs.
 */
export async function classifyImageText(
  dataUrl: string,
  client: OpenAI,
  model: string
): Promise<ImageTextResult> {
  try {
    return await classifyOnce(dataUrl, client, model);
  } catch (firstError) {
    // One retry: intermittent truncation / rate limits show up a lot past ~2k images.
    try {
      await new Promise((r) => setTimeout(r, 400));
      return await classifyOnce(dataUrl, client, model);
    } catch {
      throw firstError;
    }
  }
}
