import OpenAI from 'openai';
import { FileData, CellData } from '@/types';
import { cleanGeminiTranslationErrors, repairPiInCyrillicWords } from './text-cleaning';
import {
  OPENROUTER_BASE_URL,
  getModelFamily,
  getOpenRouterHeaders,
  toOpenRouterModelId
} from './ai-provider';

/** Every request goes to OpenRouter; only the model id differs. */
function isGeminiModel(model: string): boolean {
  return getModelFamily(model) === 'gemini';
}

/**
 * How many translation batches may be in flight at the same time.
 *
 * Translation is network-bound: each batch spends seconds waiting on the API,
 * so running a few in parallel multiplies throughput without changing results.
 * Gemini models get a lower default because the upstream Google quotas behind
 * them are tighter, even when reached through OpenRouter.
 * Override with TRANSLATION_CONCURRENCY if your plan allows more (or fewer).
 */
function getTranslationConcurrency(model: string): number {
  const fromEnv = parseInt(process.env.TRANSLATION_CONCURRENCY || '', 10);
  if (Number.isFinite(fromEnv) && fromEnv >= 1) {
    return Math.min(fromEnv, 16);
  }
  return isGeminiModel(model) ? 4 : 6;
}

/**
 * What a run had to do beyond the happy path.
 *
 * Kept so it can be reported. A run that quietly writes a few untranslated
 * questions and calls itself finished is worse than one that says what it could
 * not do: on a 1,636 question file the four at the end stayed Russian and
 * nothing in the app said so.
 */
interface RunStats {
  /** Batches where the model returned fewer translations than it was given. */
  shortBatches: number;
  /** Texts re-sent one at a time after coming back short or untranslated. */
  retried: number;
  /** How many of those came back translated the second time. */
  recovered: number;
  /** How many are still identical to their source now the run is over. */
  untouched: number;
}

/**
 * Decodes the HTML entities Excel leaves in cell text.
 *
 * These workbooks store Russian as numeric entities - "Кто" is
 * "&#1050;&#1090;&#1086;" - and a model handed that spends its output budget
 * decoding instead of translating, when it manages at all. Decoding first is
 * also what makes the π repair below possible, since it works on letters.
 */
function decodeHtmlEntities(text: string): string {
  const fromCode = (raw: string, numStr: string): string => {
    const charCode = parseInt(numStr, 10);
    if (isNaN(charCode) || charCode < 0 || charCode > 0x10ffff) return raw;
    if (charCode === 160) return ' '; // non-breaking space
    if (charCode < 32 || charCode === 127) return ' '; // control characters
    return charCode > 0xffff ? String.fromCodePoint(charCode) : String.fromCharCode(charCode);
  };

  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&copy;/g, '©')
    .replace(/&reg;/g, '®')
    .replace(/&trade;/g, '™')
    // With a semicolon: &#120583;
    .replace(/&#(\d+);/g, fromCode)
    // Without one: &#120583
    .replace(/&#(\d+)(?=[^0-9<>&;]|$|<\/|>)/g, fromCode);
}

/**
 * True when the model handed back exactly what it was given.
 *
 * This is the failure the user sees at the end of a long run: the text is still
 * Russian and nothing went wrong loudly enough to notice. Identical output is
 * the signal, and it is only trusted when the source is Cyrillic and the target
 * is not Russian, so an unchanged number, code or single letter is not mistaken
 * for one.
 */
function looksUntranslated(source: string, output: string, targetLanguage: string): boolean {
  if (/^ru|rus|рус/i.test(targetLanguage.trim())) return false;
  const before = source.trim();
  if (!before || before !== output.trim()) return false;
  return (before.match(/[а-яё]/gi) || []).length >= 3;
}

export async function translateDataWithStructure(
  fileData: FileData,
  targetLanguage: string,
  /** OpenRouter API key - the only credential the app uses. */
  apiKey: string,
  model: string = 'gemini-3-flash-preview',
  onProgress?: (current: number, total: number) => void
): Promise<FileData> {
  const translatedCells: CellData[] = [];
  const totalCells = fileData.cells.length;
  
  // Use smaller batch size for Gemini to avoid token limit / JSON truncation issues
  // Gemini: 10 texts per batch (more reliable)
  const BATCH_SIZE = isGeminiModel(model) ? 10 : 30;

  // The id OpenRouter expects. Same model, different naming:
  // "gemini-2.5-flash" is "google/gemini-2.5-flash" there.
  const requestModel = toOpenRouterModelId(model);

  const stats: RunStats = { shortBatches: 0, retried: 0, recovered: 0, untouched: 0 };

  // One client for the whole job instead of one per batch.
  const openai = new OpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: getOpenRouterHeaders()
  });

  console.log(`Translating via OpenRouter: ${model} -> ${requestModel}`);
  
  // Create batches of cells to translate
  const batches: CellData[][] = [];
  for (let i = 0; i < fileData.cells.length; i += BATCH_SIZE) {
    batches.push(fileData.cells.slice(i, Math.min(i + BATCH_SIZE, fileData.cells.length)));
  }

  // PERFORMANCE: run several batches at once instead of one at a time.
  // Batches are independent, so the whole job is limited by the slowest batch in
  // each wave rather than by the sum of every round trip. Results are written
  // back by batch index, so the final cell order is identical to sequential runs.
  const CONCURRENCY = getTranslationConcurrency(model);
  const batchResults: CellData[][] = new Array(batches.length);
  let cellsDone = 0;
  let nextBatch = 0;

  const runWorker = async (): Promise<void> => {
    while (true) {
      const batchIndex = nextBatch++;
      if (batchIndex >= batches.length) return;
      const batch = batches[batchIndex];

      batchResults[batchIndex] = await translateBatch(
        batch, targetLanguage, openai, requestModel, stats
      );

      // Update progress (counts completed cells, so it stays monotonic)
      cellsDone += batch.length;
      onProgress?.(cellsDone, totalCells);
    }
  };

  const workerCount = Math.min(CONCURRENCY, batches.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  for (const result of batchResults) {
    if (result) translatedCells.push(...result);
  }

  if (stats.retried > 0 || stats.shortBatches > 0) {
    console.log('Translation recovery:', JSON.stringify(stats));
  }
  if (stats.untouched > 0) {
    console.warn(
      `${stats.untouched} text(s) came back untranslated even after being re-sent ` +
        `one at a time. They are stored as they were.`
    );
  }
  
  return {
    ...fileData,
    id: `${fileData.id}_translated_${targetLanguage}`,
    name: `${fileData.name} (${targetLanguage})`,
    cells: translatedCells
  };
}

async function translateBatch(
  cells: CellData[],
  targetLanguage: string,
  openai: OpenAI,
  model: string,
  stats: RunStats
): Promise<CellData[]> {
  /**
   * The spacing cleanup runs for every model.
   *
   * It used to run only for Gemini, on the grounds that the mistakes it fixes
   * are Gemini's. They are not: a GPT model produced "aparmışdırb)" and
   * "edin:a)" in a real run, so the options appeared inline instead of as
   * separate choices, and nothing cleaned them up because of the model family.
   */
  const finish = (text: string) => cleanGeminiTranslation(text);
  // Helper to prepare text for translation - remove ONLY image data, translate ALL text
  const prepareTextForTranslation = (cell: CellData): string => {
    if (!cell.cleaned || cell.isEmpty) return cell.cleaned || '';
    
    let text = cell.cleaned;
    const imagePlaceholder = '[IMAGE_DATA]';
    
    // CRITICAL: If cell has images, skip sending image data entirely
    // Remove ALL HTML image tags completely (not just base64)
    if (cell.hasImages) {
      // Remove entire <img> tags with any attributes (including base64 src)
      text = text.replace(/<img[^>]*>/gi, imagePlaceholder);
      // Also remove any nested image tags in divs/spans
      text = text.replace(/<div[^>]*>[\s\S]*?<img[^>]*>[\s\S]*?<\/div>/gi, imagePlaceholder);
      text = text.replace(/<span[^>]*>[\s\S]*?<img[^>]*>[\s\S]*?<\/span>/gi, imagePlaceholder);
    }
    
    // Remove ALL base64 image data patterns (keep all text, only remove image data)
    // Match: data:image/[type];base64,[base64_data]
    // This regex matches the full image data URL including base64 content
    text = text.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=\s]+/g, imagePlaceholder);
    
    // Also handle cases where imageData might be stored separately
    if (cell.imageData) {
      text = text.replace(cell.imageData, imagePlaceholder);
      // Also remove if imageData appears in any HTML context
      text = text.replace(new RegExp(cell.imageData.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), imagePlaceholder);
    }
    
    // Remove any remaining very long base64 strings (likely image remnants)
    // Match base64 patterns that are 200+ characters (likely image data)
    text = text.replace(/[A-Za-z0-9+/=]{200,}/g, (match) => {
      // Check if it's likely base64 image data (very long, mostly alphanumeric)
      if (match.length > 500) {
        return imagePlaceholder;
      }
      return match; // Keep shorter strings as they might be legitimate text
    });
    
    // IMPORTANT: All text is kept and will be translated, only image data is replaced

    // Give the model readable Russian, not the workbook's encoding. Entities are
    // decoded, then a π that is really a Cyrillic п is put back. Both used to
    // happen further down and only for the batch path, so a text translated on
    // its own was sent as "&#1050;&#1090;&#1086;" or as "Оπределите", and came
    // back the way it went in.
    return repairPiInCyrillicWords(decodeHtmlEntities(text));
  };
  
  // Separate non-empty and empty cells
  const cellsToTranslate = cells.filter(cell => !cell.isEmpty);
  const emptyCells = cells.filter(cell => cell.isEmpty);
  
  if (cellsToTranslate.length === 0) {
    return emptyCells;
  }
  
  try {
    // Prepare texts for translation (remove image data, keep ALL text)
    const textsToTranslate = cellsToTranslate.map(cell => prepareTextForTranslation(cell));
    
    // Translate ALL texts - no skipping, only image data is excluded
    // For very large texts (>50000 chars), translate individually for better quality
    const veryLargeIndices: number[] = [];
    const normalTexts: string[] = [];
    
    textsToTranslate.forEach((text, index) => {
      // Only split very large texts (>50000) for individual translation (better quality)
      // All other texts go in batch
      if (text.length > 50000) {
        veryLargeIndices.push(index);
      } else {
        normalTexts.push(text);
      }
    });
    // Translate normal-sized texts in batch
    let batchTranslations: string[] = [];
    let batchRetried = new Set<number>();
    if (normalTexts.length > 0) {
      const result = await translateBatchTexts(
        normalTexts, targetLanguage, openai, model, stats
      );
      batchTranslations = result.translations;
      batchRetried = result.retried;
    }

    // Translate very large texts individually for better quality (but still translate them!)
    const largeTranslations: Map<number, string> = new Map();
    for (const index of veryLargeIndices) {
      try {
        const cell = cellsToTranslate[index];
        const preparedText = prepareTextForTranslation(cell);
        const translation = await translateText(preparedText, targetLanguage, openai, model);
        largeTranslations.set(index, translation);
      } catch (error) {
        console.error(`Error translating very large cell at index ${index}:`, error);
        // Fallback: use original prepared text (with image placeholders)
        largeTranslations.set(index, textsToTranslate[index]);
      }
    }

    // Combine batch and individual translations in correct order
    const allTranslations: string[] = [];
    /** Cells that have already had a request of their own - not worth a second. */
    const alreadyAlone = new Set<number>();
    let batchIdx = 0;

    for (let i = 0; i < cellsToTranslate.length; i++) {
      if (veryLargeIndices.includes(i)) {
        allTranslations.push(largeTranslations.get(i) || textsToTranslate[i]);
        alreadyAlone.add(i);
      } else {
        allTranslations.push(batchTranslations[batchIdx] || textsToTranslate[i]);
        if (batchRetried.has(batchIdx)) alreadyAlone.add(i);
        batchIdx++;
      }
    }

    // Anything the model handed straight back is re-sent on its own. A text
    // alone in its own request is a far easier job than one line out of thirty,
    // and this is what stops a run from finishing with a few questions still in
    // the source language and nothing saying so.
    for (let i = 0; i < allTranslations.length; i++) {
      if (alreadyAlone.has(i)) continue;
      if (!looksUntranslated(textsToTranslate[i], allTranslations[i], targetLanguage)) continue;
      stats.retried++;
      try {
        const retry = await translateText(textsToTranslate[i], targetLanguage, openai, model);
        if (!looksUntranslated(textsToTranslate[i], retry, targetLanguage)) {
          allTranslations[i] = retry;
          stats.recovered++;
        }
      } catch (error) {
        // One refusal means the next will be refused too - an expired key, a
        // rate limit, the service down. Retrying the rest would multiply the
        // wait for nothing, so the batch keeps what it has and moves on.
        console.error('Re-sending an untranslated text failed, stopping retries:', error);
        break;
      }
    }

    // Counted once, here, so a text that was re-sent twice is still one number.
    for (let i = 0; i < allTranslations.length; i++) {
      if (looksUntranslated(textsToTranslate[i], allTranslations[i], targetLanguage)) {
        stats.untouched++;
      }
    }
    // Map translations back to cells
    // IMPORTANT: Preserve the original field (with HTML/images) and only update cleaned field
    const translatedCells: CellData[] = cellsToTranslate.map((cell, index) => {
      let translatedText = allTranslations[index];
      
      // For cells with images, restore the image data in the translation
      if (cell.hasImages && cell.imageData && translatedText.includes('[IMAGE_DATA]')) {
        translatedText = translatedText.replace('[IMAGE_DATA]', cell.imageData);
      }
      
      return {
        ...cell,
        cleaned: finish(translatedText)
        // Keep original as-is (don't overwrite it with cleaned text)
      };
    });
    
    return [...translatedCells, ...emptyCells];
    
  } catch (error) {
    console.error('Batch translation error:', error);
    // If batch fails, fall back to individual translation
    const translatedCells: CellData[] = [];
    for (const cell of cells) {
      if (cell.isEmpty) {
        translatedCells.push({ ...cell });
      } else {
        try {
          const preparedText = prepareTextForTranslation(cell);
          const translatedText = await translateText(preparedText, targetLanguage, openai, model);
          
          let finalTranslation = translatedText;
          // Restore ALL image data if it was replaced
          if (cell.hasImages && cell.imageData) {
            finalTranslation = finalTranslation.replace('[IMAGE_DATA]', cell.imageData);
          }
          
          // Also restore any other base64 image patterns
          const imagePatterns = cell.original?.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=\s]+/g);
          if (imagePatterns) {
            imagePatterns.forEach((pattern) => {
              if (finalTranslation.includes('[IMAGE_DATA]')) {
                finalTranslation = finalTranslation.replace('[IMAGE_DATA]', pattern);
              }
            });
          }
          
          translatedCells.push({
            ...cell,
            cleaned: finish(finalTranslation)
            // Keep original as-is (preserve HTML/images)
          });
        } catch (error) {
          console.error('Individual translation error:', error);
          translatedCells.push({ ...cell });
        }
      }
    }
    return translatedCells;
  }
}


/**
 * The translations, plus which of them already had a request of their own.
 *
 * The caller re-sends anything that came back untranslated, and this is how it
 * knows not to pay for a second attempt at a text that has already had one.
 */
interface BatchResult {
  translations: string[];
  retried: Set<number>;
}

async function translateBatchTexts(
  texts: string[],
  targetLanguage: string,
  openai: OpenAI,
  model: string,
  stats: RunStats
): Promise<BatchResult> {
  console.log('Sending batch of', texts.length, 'texts for translation');
  
  try {
    // The entity decoder that used to live here is now decodeHtmlEntities, run
    // in prepareTextForTranslation so that a text sent on its own gets it too.
    
    // Build a safer prompt that avoids JSON escaping issues
    const textsJSON = texts.map((text, index) => {
      // Escape special characters properly
      const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
      return `${index + 1}. "${escaped}"`;
    }).join('\n');
    
    const prompt = `You are a professional translator. Translate the following texts to ${targetLanguage}.

RULES:
- Translate each text accurately preserving all formatting and HTML tags
- CRITICAL: Preserve paragraph structure - questions and options should be properly separated
- CRITICAL: Always add a space after question marks (?) before numbered/lettered options (I., II., 1., 2., etc.)
- CRITICAL: Ensure proper spacing between multiple choice options (I., II., III., IV. or 1., 2., 3., 4.)
- CRITICAL: If options appear on the same line, separate them with spaces: "I. Option II. Option" NOT "I. OptionII. Option"
- Return ONLY a valid JSON object with this exact structure: {"translations": ["translation1", "translation2", ...]}
- Keep the exact same order as the input
- Escape all special characters in JSON strings properly
- Do NOT add explanations, comments, or extra content
- Return ONLY the JSON object

PARAGRAPHING EXAMPLES:
❌ WRONG: "Question?I. Option II. Option"
✅ CORRECT: "Question? I. Option II. Option"

❌ WRONG: "Question?1. Option2. Option"
✅ CORRECT: "Question? 1. Option 2. Option"

Texts to translate:
${textsJSON}

Return only the JSON object:`;

    const response = await openai.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content: 'You are a professional translator. You translate text accurately while preserving formatting and structure. You ALWAYS return valid, properly escaped JSON without any additional text.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      response_format: { type: "json_object" },
      max_tokens: 8000,
      temperature: 0.2
    });
    
    let result = response.choices[0]?.message?.content?.trim() || '';
    console.log('Raw response length:', result.length, 'chars');
    
    // Try to extract JSON if there's extra text around it
    if (!result.startsWith('{')) {
      const match = result.match(/\{[\s\S]*\}/);
      if (match) {
        result = match[0];
        console.log('Extracted JSON from response');
      }
    }
    
    // Parse as JSON object
    const parsed = JSON.parse(result);
    
    if (parsed.translations && Array.isArray(parsed.translations)) {
      console.log('Successfully parsed', parsed.translations.length, 'translations');
      
      // Ensure we have the right number of translations
      if (parsed.translations.length === texts.length) {
        return { translations: parsed.translations, retried: new Set() };
      } else {
        // The model stopped early - it ran out of output budget, or dropped a
        // line. The ones it never reached are translated individually.
        //
        // They used to be filled in with their own source text. That is why a
        // 1,636 question run ended with the last four questions still in
        // Russian: the batch that covered them came back short, the gap was
        // papered over with the input, and the run reported success.
        console.warn('Translation count mismatch:', parsed.translations.length, 'vs', texts.length);
        stats.shortBatches++;
        const translations = [...parsed.translations];
        const retried = new Set<number>();
        for (let i = translations.length; i < texts.length; i++) {
          retried.add(i);
          stats.retried++;
          try {
            translations.push(await translateText(texts[i], targetLanguage, openai, model));
          } catch (error) {
            console.error('Could not translate a text the batch left out:', error);
            translations.push(texts[i]);
          }
        }
        return { translations, retried };
      }
    }

    console.warn('No translations found in response');
    return { translations: texts, retried: new Set() };
    
  } catch (error) {
    console.error('Failed to parse translations:', error);
    // Fall back to individual translation
    console.log('Falling back to individual translation for batch');
    return await translateBatchIndividually(texts, targetLanguage, openai, model, stats);
  }
}

async function translateBatchIndividually(
  texts: string[],
  targetLanguage: string,
  openai: OpenAI,
  model: string,
  stats: RunStats
): Promise<BatchResult> {
  console.log('Translating', texts.length, 'texts individually as fallback');
  const translations: string[] = [];
  // Every one of these has had a request of its own, so the caller does not
  // send them again when the service is the thing that is broken.
  const retried = new Set<number>(texts.map((_, i) => i));
  stats.retried += texts.length;
  
  for (let i = 0; i < texts.length; i++) {
    try {
      const translation = await translateText(texts[i], targetLanguage, openai, model);
      translations.push(translation);
    } catch (error) {
      console.error(`Failed to translate text ${i + 1}:`, error);
      translations.push(texts[i]); // Use original on error
    }
  }
  
  return { translations, retried };
}

async function translateText(
  text: string,
  targetLanguage: string,
  openai: OpenAI,
  model: string
): Promise<string> {
  if (!text.trim()) return text;
  
  const prompt = `Translate this text to ${targetLanguage}. 

CRITICAL RULES:
1. Preserve all formatting, structure, and HTML tags
2. CRITICAL: Always add a space after question marks (?) before numbered/lettered options (I., II., 1., 2., etc.)
3. CRITICAL: Ensure proper spacing between multiple choice options
4. Return ONLY the translated text, nothing else

PARAGRAPHING EXAMPLES:
❌ WRONG: "Question?I. Option II. Option"
✅ CORRECT: "Question? I. Option II. Option"

❌ WRONG: "Question?1. Option2. Option"
✅ CORRECT: "Question? 1. Option 2. Option"

Text: ${text}

Translation:`;
  
  const response = await openai.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content: 'You are a professional translator. Translate accurately while preserving all formatting.'
      },
      {
        role: 'user',
        content: prompt
      }
    ],
    max_tokens: 4000,
    temperature: 0.2
  });
  
  const translated = response.choices[0]?.message?.content?.trim() || text;
  console.log('Single translation:', translated.substring(0, 100));
  return translated;
}


// Helper function to clean Gemini translations (fixes common formatting issues)
function cleanGeminiTranslation(text: string): string {
  if (!text) return text;
  
  // Use shared cleaning function
  text = cleanGeminiTranslationErrors(text);
  
  // Additional fixes specific to translation output
  // FIX: Fix missing space after colon before list: "xətlər:1." -> "xətlər: 1."
  text = text.replace(/([a-zа-яәəıöüğşçа-я]):([1-9])\./gi, '$1: $2.');
  
  // FIX: Fix consecutive markers without space: "1.Item2." -> "1. Item 2."
  text = text.replace(/([1-9]\.)\s*([A-ZА-ЯӘƏİÖÜĞŞÇ][a-zа-яәəıöüğşçа-я]+)([1-9])\./g, '$1 $2 $3.');
  
  return text;
}

