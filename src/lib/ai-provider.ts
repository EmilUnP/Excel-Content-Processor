/**
 * OpenRouter is the only AI provider this app uses.
 *
 * Every model in the picker - the Gemini options alike -
 * is served through OpenRouter's OpenAI-compatible API with a single key.
 * There are no direct OpenAI or Google AI Studio paths.
 *
 * Model family still matters, though: a Gemini model reached through OpenRouter
 * is still a Gemini model, and its output still needs the Gemini-specific
 * spacing cleanup. Family (what the model is) and provider (who serves it) are
 * separate ideas.
 */

export type ModelFamily = 'openai' | 'gemini';

/**
 * OpenRouter's API root. Overridable so the app can be pointed at a compatible
 * gateway or proxy (and so the routing can be exercised in tests without
 * spending real credits).
 */
export const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

/**
 * App model id -> OpenRouter model id.
 *
 * Verified against OpenRouter's public model list; every entry exists and
 * supports `response_format`, so the JSON-mode prompt works unchanged.
 */
const OPENROUTER_MODEL_IDS: Record<string, string> = {
  'gemini-3-flash-preview': 'google/gemini-3-flash-preview',
  'gemini-2.5-flash': 'google/gemini-2.5-flash',
  'gemini-2.5-pro': 'google/gemini-2.5-pro'
};

export function getModelFamily(model: string): ModelFamily {
  return model.startsWith('gemini-') ? 'gemini' : 'openai';
}

export function isOpenRouterConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

/**
 * Translates an app model id into the id OpenRouter expects.
 *
 * Falls back to prefixing by family so a model added to the picker still works
 * before this table is updated. OPENROUTER_MODEL_MAP can override any entry
 * without a code change, for example when pinning a dated snapshot:
 *   OPENROUTER_MODEL_MAP={"gemini-3-flash-preview":"google/gemini-3-flash-preview"}
 */
export function toOpenRouterModelId(model: string): string {
  const overrides = process.env.OPENROUTER_MODEL_MAP;
  if (overrides) {
    try {
      const parsed = JSON.parse(overrides) as Record<string, string>;
      if (typeof parsed[model] === 'string') return parsed[model];
    } catch {
      console.warn('OPENROUTER_MODEL_MAP is not valid JSON; ignoring it.');
    }
  }

  if (OPENROUTER_MODEL_IDS[model]) return OPENROUTER_MODEL_IDS[model];
  // Already namespaced (e.g. someone typed "anthropic/claude-..."): pass through.
  if (model.includes('/')) return model;
  return `${getModelFamily(model) === 'gemini' ? 'google' : 'openai'}/${model}`;
}

/**
 * Headers OpenRouter uses for attribution on its dashboard. Both are optional
 * and neither affects routing.
 */
export function getOpenRouterHeaders(): Record<string, string> {
  return {
    'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:3010',
    'X-Title': process.env.OPENROUTER_APP_NAME || 'Excel Content Processor'
  };
}
