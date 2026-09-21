/**
 * Every model the app offers, defined in one place: the .env file.
 *
 * Model ids move fast - a new Gemini or GPT appears, an old one is retired, a
 * price changes. Before this, adding one meant editing a picker component, a
 * mapping table and a service file. Now it is one line of configuration and a
 * restart, with no code change and no rebuild: the lists are read per request
 * and handed to the browser by `/api/provider`.
 *
 * Format, in all cases a comma-separated list:
 *
 *   TRANSLATION_MODELS=openai/gpt-4o-mini|GPT-4o Mini,google/gemini-2.5-pro
 *   IMAGE_TRANSLATE_MODELS=google/gemini-3-pro-image|Gemini 3 Pro Image|0.139
 *
 * The label and the cost are optional; a missing label is derived from the id.
 */

export interface ModelOption {
  /** OpenRouter model id, e.g. "openai/gpt-4o-mini". */
  id: string;
  /** Shown in the picker. */
  name: string;
  /** "OpenAI", "Google", … taken from the id's owner prefix. */
  provider: string;
}

export interface ImageModelOption extends ModelOption {
  /** Rough USD cost of redrawing one image, used for the estimate. */
  costPerImage: number;
}

/** "openai/gpt-4o-mini" -> "OpenAI". */
function providerOf(id: string): string {
  const owner = id.includes('/') ? id.slice(0, id.indexOf('/')) : '';
  if (!owner) return 'OpenRouter';
  if (owner === 'openai') return 'OpenAI';
  if (owner === 'google') return 'Google';
  if (owner === 'anthropic') return 'Anthropic';
  return owner.charAt(0).toUpperCase() + owner.slice(1);
}

/** "openai/gpt-4o-mini" -> "Gpt 4o Mini", used when no label is given. */
function nameOf(id: string): string {
  const tail = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
  return tail
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Parses `id|Label` entries. */
export function parseModels(raw: string | undefined, fallback: string): ModelOption[] {
  const entries = parseList(raw);
  const source = entries.length > 0 ? entries : parseList(fallback);

  return source.map((entry) => {
    const [id, label] = entry.split('|').map((p) => p.trim());
    return { id, name: label || nameOf(id), provider: providerOf(id) };
  });
}

/** Parses `id|Label|cost` entries. */
export function parseImageModels(raw: string | undefined, fallback: string): ImageModelOption[] {
  const entries = parseList(raw);
  const source = entries.length > 0 ? entries : parseList(fallback);

  return source.map((entry) => {
    const [id, label, cost] = entry.split('|').map((p) => p.trim());
    const parsed = Number.parseFloat(cost);
    return {
      id,
      name: label || nameOf(id),
      provider: providerOf(id),
      costPerImage: Number.isFinite(parsed) ? parsed : 0
    };
  });
}

// Defaults used when the .env says nothing. Every id here was checked against
// OpenRouter's live model list, and the image costs were measured with one real
// call each.
const FALLBACK_TRANSLATION_MODELS =
  'openai/gpt-4o-mini|GPT-4o Mini,' +
  'openai/gpt-4o|GPT-4o,' +
  'google/gemini-2.5-flash|Gemini 2.5 Flash,' +
  'google/gemini-2.5-pro|Gemini 2.5 Pro,' +
  'google/gemini-3-flash-preview|Gemini 3 Flash';

const FALLBACK_IMAGE_TRANSLATE_MODELS =
  'google/gemini-3-pro-image|Gemini 3 Pro Image|0.139,' +
  'openai/gpt-5.4-image-2|GPT-5.4 Image 2|0.05,' +
  'google/gemini-2.5-flash-image|Gemini 2.5 Flash Image|0.039';

/** Picks a default that actually exists in the list. */
function resolveDefault(requested: string | undefined, options: { id: string }[]): string {
  const first = options[0]?.id || '';
  if (!requested) return first;
  return options.some((o) => o.id === requested) ? requested : first;
}

export function getTranslationModels(): ModelOption[] {
  return parseModels(process.env.TRANSLATION_MODELS, FALLBACK_TRANSLATION_MODELS);
}

export function getDefaultTranslationModel(): string {
  return resolveDefault(process.env.TRANSLATION_MODEL_DEFAULT, getTranslationModels());
}

export function getImageTranslateModels(): ImageModelOption[] {
  return parseImageModels(
    process.env.IMAGE_TRANSLATE_MODELS,
    FALLBACK_IMAGE_TRANSLATE_MODELS
  );
}

export function getDefaultImageTranslateModel(): string {
  return resolveDefault(process.env.IMAGE_TRANSLATE_MODEL_DEFAULT, getImageTranslateModels());
}

/** Model that reads the text inside images. Any vision-capable model will do. */
export function getImageTextModel(): string {
  return process.env.IMAGE_TEXT_MODEL || getDefaultTranslationModel();
}
