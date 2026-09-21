import { NextRequest, NextResponse } from 'next/server';
import { FileStorage } from '@/lib/file-storage';
import { CellData, FileData } from '@/types';
import { analyzeImageQuestions, extractImageTags } from '@/lib/question-model';
import {
  ImageTextKind,
  ImageTextLanguage,
  ImageTextResult,
  classifyImageText,
  createVisionClient,
  getImageAnalysisConcurrency
} from '@/lib/image-text-service';
import { imageKey, loadCache, readEntry, saveCache, writeEntry } from '@/lib/image-text-cache';
import { getImageTextModel } from '@/lib/model-config';

/**
 * Keeps only the questions whose images contain translatable text.
 *
 * POST /api/files/image-text   body: { fileId, model? }
 *
 * Step 2 of the image pipeline. Step 1 (`/api/files/images`) narrowed the file
 * to questions that have pictures at all, using flags computed at upload time.
 * This step looks *inside* each picture with a vision model and asks whether it
 * contains words, so a later version can translate them.
 *
 * A diagram labelled "1 2 3 4" survives step 1 but not this one - there is
 * nothing in it to translate.
 *
 * The response is a stream of newline-delimited JSON events rather than one
 * object at the end. Reading a few hundred images takes minutes, and without
 * progress the UI cannot tell "working" from "hung":
 *
 *   {"type":"start","total":128,"cached":40}
 *   {"type":"progress","done":41,"total":128}
 *   {"type":"done","data":{...},"stats":{...}}
 *   {"type":"error","error":"..."}
 *
 * Every classification is cached by image content, so re-running costs nothing.
 * The source file is left untouched; the result is saved as `<fileId>_imagetext`.
 */

const SRC_RE = /src\s*=\s*"(data:image\/[^"]+)"/i;

/** Pulls the data URLs out of a cell's stored HTML. */
function imageUrlsOf(cell: CellData): string[] {
  const urls: string[] = [];
  for (const tag of extractImageTags(cell.original)) {
    const match = tag.match(SRC_RE);
    if (match) urls.push(match[1]);
  }
  // Some cells keep the payload separately rather than inline.
  if (urls.length === 0 && cell.imageData && cell.imageData.startsWith('data:image')) {
    urls.push(cell.imageData);
  }
  return urls;
}

type Emit = (event: Record<string, unknown>) => void;

/** Does the work, reporting progress through `send`. */
async function runFilter(
  fileId: string,
  model: string,
  /** Keep only images whose words are in this language; 'any' skips the check. */
  language: ImageTextLanguage | 'any',
  apiKey: string,
  send: Emit
) {
  const needLanguage = language !== 'any';
  const file = await FileStorage.getFile(fileId);
  if (!file) {
    send({ type: 'error', error: 'File not found' });
    return;
  }

  // Rebuild the row grid, exactly as the table and step 1 do.
  let maxRow = 0;
  let maxCol = 0;
  for (const cell of file.cells) {
    if (cell.rowIndex > maxRow) maxRow = cell.rowIndex;
    if (cell.colIndex > maxCol) maxCol = cell.colIndex;
  }
  const rows: (CellData | null)[][] = [];
  for (let i = 0; i <= maxRow; i++) rows[i] = new Array(maxCol + 1).fill(null);
  for (const cell of file.cells) rows[cell.rowIndex][cell.colIndex] = cell;

  const report = analyzeImageQuestions(rows);
  if (report.questions.length === 0) {
    send({ type: 'error', error: 'No question in this file contains an image.' });
    return;
  }

  // Collect every distinct image once. The same picture often appears in
  // several variants of the same question.
  const urlsByQuestion = new Map<number, string[]>();
  const uniqueUrls = new Map<string, string>(); // key -> dataUrl

  for (const question of report.questions) {
    const urls: string[] = [];
    for (const cell of rows[question.rowIndex]) {
      if (!cell || !cell.hasImages) continue;
      for (const url of imageUrlsOf(cell)) {
        urls.push(url);
        uniqueUrls.set(imageKey(url, model), url);
      }
    }
    urlsByQuestion.set(question.rowIndex, urls);
  }

  // Classify, using the cache wherever possible.
  const cache = await loadCache();
  const verdicts = new Map<string, ImageTextResult>();
  const pending: Array<[string, string]> = [];

  for (const [key, url] of Array.from(uniqueUrls.entries())) {
    const cached = readEntry(cache, key, needLanguage);
    if (cached) verdicts.set(key, cached);
    else pending.push([key, url]);
  }

  const fromCache = uniqueUrls.size - pending.length;
  send({ type: 'start', total: uniqueUrls.size, cached: fromCache, model, language });

  const client = createVisionClient(apiKey);
  let analyzed = 0;
  let failed = 0;
  let next = 0;
  let done = fromCache;

  // Report at most ~1 event per image, but never faster than every 150ms, so a
  // large file does not flood the stream.
  let lastSent = 0;
  const reportProgress = (force = false) => {
    const now = Date.now();
    if (force || now - lastSent > 150) {
      lastSent = now;
      send({ type: 'progress', done, total: uniqueUrls.size });
    }
  };
  reportProgress(true);

  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= pending.length) return;
      const [key, url] = pending[index];
      try {
        const result = await classifyImageText(url, client, model);
        verdicts.set(key, result);
        writeEntry(cache, key, model, result);
        analyzed++;
      } catch (error) {
        // An image we cannot read is treated as having no text: it is better
        // to drop a doubtful question than to claim it is translatable.
        console.error('Image classification failed:', error);
        verdicts.set(key, { kind: 'none', language: 'none', sample: '' });
        failed++;
      }
      done++;
      reportProgress();
    }
  };

  const workerCount = Math.min(getImageAnalysisConcurrency(), pending.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  reportProgress(true);
  await saveCache(cache);

  // A question survives when at least one of its images carries words - and,
  // when a language was requested, words in that language. Text in a language
  // you are not translating into is no more useful than no text at all.
  const qualifies = (url: string) => {
    const verdict = verdicts.get(imageKey(url, model));
    if (!verdict || verdict.kind !== 'words') return false;
    return language === 'any' || verdict.language === language;
  };

  const kept = report.questions.filter((question) =>
    (urlsByQuestion.get(question.rowIndex) || []).some(qualifies)
  );

  const kindTotals: Record<ImageTextKind, number> = { words: 0, numeric: 0, none: 0 };
  const languageTotals: Record<string, number> = {};
  for (const verdict of Array.from(verdicts.values())) {
    kindTotals[verdict.kind]++;
    if (verdict.kind === 'words') {
      languageTotals[verdict.language] = (languageTotals[verdict.language] || 0) + 1;
    }
  }

  const inTargetLanguage =
    language === 'any' ? kindTotals.words : languageTotals[language] || 0;

  if (kept.length === 0) {
    const languageNote =
      language === 'any'
        ? ''
        : ` None of the ${kindTotals.words} image(s) with words are in "${language}" ` +
          `(found: ${Object.entries(languageTotals).map(([l, n]) => `${l} ${n}`).join(', ') || 'none'}).`;
    send({
      type: 'error',
      error:
        `No question survived the filter. Of ${uniqueUrls.size} image(s): ` +
        `${kindTotals.words} with words, ${kindTotals.numeric} numbers or symbols only, ` +
        `${kindTotals.none} with no text.${languageNote}`
    });
    return;
  }

  // Re-number the kept rows so the table does not build a mostly empty grid.
  const cells: CellData[] = [];
  kept.forEach((question, newRowIndex) => {
    for (const cell of rows[question.rowIndex]) {
      if (!cell) continue;
      cells.push({ ...cell, rowIndex: newRowIndex });
    }
  });

  const filteredId = `${fileId}_imagetext`;
  const filtered: FileData = {
    id: filteredId,
    name: `${file.name} (images with text)`,
    uploadDate: new Date().toISOString(),
    totalRows: kept.length,
    totalColumns: file.totalColumns,
    cells
  };

  await FileStorage.saveFile(filteredId, filtered);

  const stats = {
    questionsScanned: report.stats.totalQuestions,
    questionsWithImages: report.stats.withImages,
    questionsKept: kept.length,
    questionsRemoved: report.stats.withImages - kept.length,
    uniqueImages: uniqueUrls.size,
    imagesAnalyzed: analyzed,
    imagesFromCache: fromCache,
    imagesFailed: failed,
    withWords: kindTotals.words,
    numericOnly: kindTotals.numeric,
    noText: kindTotals.none,
    language,
    inTargetLanguage,
    languageTotals,
    model
  };

  console.log('Image-text filter:', JSON.stringify(stats));
  send({ type: 'done', data: filtered, stats });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { fileId, language = 'any' } = body;
  // Falls back to the env-configured reader when the client does not name one.
  const model: string = body.model || getImageTextModel();

  // Problems we can detect before any work starts stay ordinary JSON errors,
  // so a plain client (or curl) still sees a status code.
  if (!fileId) {
    return NextResponse.json({ success: false, error: 'File ID is required' }, { status: 400 });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        success: false,
        error: 'OPENROUTER_API_KEY is not set. Add it to your .env file - get a key at https://openrouter.ai/keys'
      },
      { status: 500 }
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send: Emit = (event) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
      };
      try {
        await runFilter(fileId, model, language, apiKey, send);
      } catch (error) {
        console.error('Image-text filter error:', error);
        send({
          type: 'error',
          error: error instanceof Error ? error.message : 'Failed to analyse the images'
        });
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      // Stops intermediate proxies buffering the stream into one lump.
      'X-Accel-Buffering': 'no'
    }
  });
}
