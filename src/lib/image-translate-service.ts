import OpenAI from 'openai';
import {
  OPENROUTER_BASE_URL,
  getOpenRouterHeaders
} from './ai-provider';

/**
 * Redraws an image with its text translated, leaving everything else alone.
 *
 * This is the expensive step. Image-editing models do not patch pixels - they
 * regenerate the whole picture from the original plus an instruction. In
 * practice the diagram comes back faithfully, but it is a redraw, not an edit,
 * and the model picks its own output size. Both facts are handled by the
 * caller rather than hidden.
 */

export interface ImageTranslateModel {
  id: string;
  name: string;
  /** Measured cost of one real edit of a 288x248 diagram, in USD. */
  costPerImage: number;
  note: string;
}

/**
 * Models that can take an image in and return an edited image out, with the
 * cost of one measured call each. Anything without image output cannot do this
 * job at all, however good it is at text.
 */
export const IMAGE_TRANSLATE_MODELS: ImageTranslateModel[] = [
  {
    id: 'google/gemini-3-pro-image',
    name: 'Gemini 3 Pro Image',
    costPerImage: 0.139,
    note: 'Best fidelity - nothing clipped, cleanest lines'
  },
  {
    id: 'openai/gpt-5.4-image-2',
    name: 'GPT-5.4 Image 2',
    costPerImage: 0.05,
    note: 'OpenAI alternative (cost is an estimate)'
  },
  {
    id: 'google/gemini-2.5-flash-image',
    name: 'Gemini 2.5 Flash Image',
    costPerImage: 0.039,
    note: 'Cheapest - good, but can crop edges'
  }
];

export const DEFAULT_IMAGE_TRANSLATE_MODEL = IMAGE_TRANSLATE_MODELS[0].id;

export interface ImageTranslateResult {
  /** The edited image as a `data:image/...;base64,...` URL. */
  dataUrl: string;
  width: number;
  height: number;
  /** What OpenRouter billed for this one call, when it tells us. */
  cost: number;
}

/** Reads width/height straight out of a PNG's IHDR chunk. */
export function pngSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  const isPng = buffer.readUInt32BE(0) === 0x89504e47;
  if (!isPng) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export function sizeOfDataUrl(dataUrl: string): { width: number; height: number } | null {
  try {
    return pngSize(Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
  } catch {
    return null;
  }
}

/**
 * The instruction.
 *
 * Every clause here exists because the model will otherwise take liberties:
 * restyling the drawing, "improving" the layout, translating the single-letter
 * labels that are actually variables, or answering in prose instead of
 * returning a picture.
 */
function buildInstruction(targetLanguage: string): string {
  return (
    `Translate every word of text in this image into ${targetLanguage}.\n\n` +
    `Keep EVERYTHING else exactly as it is:\n` +
    `- the drawing itself: every line, shape, curve, arrow and its position\n` +
    `- all colours, stroke widths and the background\n` +
    `- the layout and the position, size, font and colour of each text label\n\n` +
    `Replace only the words, in place. Do not redraw, restyle or "improve" the ` +
    `picture. Do not add, remove, resize or move anything.\n\n` +
    `Leave unchanged: numbers, mathematical and chemical formulas, units, and ` +
    `single letters used as labels or variables (A, B, K, L, M, x, n).\n\n` +
    `Return the edited image at the same aspect ratio as the input. Return an ` +
    `image, not a description.`
  );
}

export function createImageClient(apiKey: string): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: getOpenRouterHeaders()
  });
}

/** Finds the returned picture wherever the provider chose to put it. */
function extractImage(response: unknown): string | null {
  const message = (response as {
    choices?: Array<{ message?: { images?: Array<{ image_url?: { url?: string } }> } }>;
  })?.choices?.[0]?.message;

  const fromImages = message?.images?.[0]?.image_url?.url;
  if (typeof fromImages === 'string' && fromImages.startsWith('data:image')) {
    return fromImages;
  }

  // Providers differ in where they put it; fall back to scanning the payload.
  const match = JSON.stringify(response).match(/data:image\/[a-zA-Z]+;base64,[A-Za-z0-9+/=]+/);
  return match ? match[0] : null;
}

export async function translateImage(
  dataUrl: string,
  targetLanguage: string,
  client: OpenAI,
  model: string
): Promise<ImageTranslateResult> {
  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: buildInstruction(targetLanguage) },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }
    ],
    // Without this the provider may answer with prose instead of a picture.
    modalities: ['image', 'text']
  } as Parameters<typeof client.chat.completions.create>[0]);

  const edited = extractImage(response);
  if (!edited) throw new Error('The model returned no image');

  const size = sizeOfDataUrl(edited);
  const cost =
    (response as unknown as { usage?: { cost?: number } })?.usage?.cost ?? 0;

  return {
    dataUrl: edited,
    width: size?.width ?? 0,
    height: size?.height ?? 0,
    cost
  };
}
