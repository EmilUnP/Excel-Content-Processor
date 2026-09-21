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

Return ONLY a JSON object, no commentary:
{"kind":"words"|"numeric"|"none","language":"ru"|"az"|"en"|"tr"|"other"|"none","sample":"<up to 60 characters of the text you saw, or an empty string>"}`;

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

function parseResult(raw: string): ImageTextResult {
  let text = raw.trim();
  if (!text.startsWith('{')) {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) text = match[0];
  }

  const parsed = JSON.parse(text) as { kind?: string; language?: string; sample?: string };
  const kind: ImageTextKind =
    parsed.kind === 'words' || parsed.kind === 'numeric' || parsed.kind === 'none'
      ? parsed.kind
      : 'none';

  const known: ImageTextLanguage[] = ['ru', 'az', 'en', 'tr', 'other', 'none'];
  let language: ImageTextLanguage =
    known.includes(parsed.language as ImageTextLanguage)
      ? (parsed.language as ImageTextLanguage)
      : 'other';
  // Only "words" can carry a language; anything else has nothing to translate.
  if (kind !== 'words') language = 'none';

  return {
    kind,
    language,
    sample: typeof parsed.sample === 'string' ? parsed.sample.slice(0, 60) : ''
  };
}

/**
 * Classifies a single image given as a `data:image/...;base64,...` URL.
 *
 * Throws on API failure; the caller decides what an unclassifiable image means.
 */
export async function classifyImageText(
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
    max_tokens: 200,
    // The task is a classification, not a creative one - keep it repeatable.
    temperature: 0
  });

  const raw = response.choices[0]?.message?.content?.trim() || '';
  if (!raw) throw new Error('Empty response from the vision model');
  return parseResult(raw);
}
