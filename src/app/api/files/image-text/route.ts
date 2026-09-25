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
 * Streams NDJSON progress. On success the filtered file is saved to disk and
 * the final event carries only `{ fileId, stats }` — never the full file body.
 * Shipping megabytes of base64 images in one stream line was freezing the
 * browser on runs with thousands of images.
 */

export const maxDuration = 3600;
export const dynamic = 'force-dynamic';

const SRC_RE = /src\s*=\s*"(data:image\/[^"]+)"/i;
/** Flush cache to disk this often so a crash mid-run does not lose paid work. */
const CACHE_SAVE_EVERY = 40;

/** Pulls the data URLs out of a cell's stored HTML. */
function imageUrlsOf(cell: CellData): string[] {
  const urls: string[] = [];
  for (const tag of extractImageTags(cell.original)) {
    const match = tag.match(SRC_RE);
    if (match) urls.push(match[1]);
  }
  if (urls.length === 0 && cell.imageData && cell.imageData.startsWith('data:image')) {
    urls.push(cell.imageData);
  }
  return urls;
}

type Emit = (event: Record<string, unknown>) => void;

async function runFilter(
  fileId: string,
  model: string,
  language: ImageTextLanguage | 'any',
  apiKey: string,
  send: Emit,
  signal?: AbortSignal
) {
  const needLanguage = language !== 'any';
  const file = await FileStorage.getFile(fileId);
  if (!file) {
    send({ type: 'error', error: 'File not found' });
    return;
  }

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

  const urlsByQuestion = new Map<number, string[]>();
  const uniqueUrls = new Map<string, string>();

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
  let sinceCacheSave = 0;

  // Cap UI updates so a 5k-image run does not flood React.
  let lastSent = 0;
  const reportProgress = (force = false) => {
    const now = Date.now();
    if (force || now - lastSent > 250) {
      lastSent = now;
      send({ type: 'progress', done, total: uniqueUrls.size });
    }
  };
  reportProgress(true);

  const worker = async () => {
    while (true) {
      if (signal?.aborted) return;
      const index = next++;
      if (index >= pending.length) return;
      const [key, url] = pending[index];
      try {
        const result = await classifyImageText(url, client, model);
        if (signal?.aborted) return;
        verdicts.set(key, result);
        writeEntry(cache, key, model, result);
        analyzed++;
        sinceCacheSave++;
      } catch (error) {
        console.error('Image classification failed:', error);
        // Unreadable → treat as no text (safer than claiming it is translatable).
        verdicts.set(key, { kind: 'none', language: 'none', sample: '' });
        failed++;
        sinceCacheSave++;
      }
      done++;
      reportProgress();

      // Persist cache in chunks so a mid-run crash still keeps paid verdicts.
      if (sinceCacheSave >= CACHE_SAVE_EVERY) {
        sinceCacheSave = 0;
        await saveCache(cache);
      }
    }
  };

  const workerCount = Math.min(getImageAnalysisConcurrency(), Math.max(pending.length, 1));
  if (pending.length > 0) {
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }

  if (signal?.aborted) {
    await saveCache(cache);
    send({ type: 'error', error: 'Analysis was cancelled.' });
    return;
  }

  reportProgress(true);
  await saveCache(cache);

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

  send({
    type: 'finalizing',
    message: 'Saving filtered file…',
    done: uniqueUrls.size,
    total: uniqueUrls.size
  });
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
  // fileId only — client loads the file over GET. Never stream the full body.
  send({ type: 'done', fileId: filteredId, stats });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { fileId, language = 'any' } = body;
  const model: string = body.model || getImageTextModel();

  if (!fileId) {
    return NextResponse.json({ success: false, error: 'File ID is required' }, { status: 400 });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        success: false,
        error:
          'OPENROUTER_API_KEY is not set. Add it to your .env file - get a key at https://openrouter.ai/keys'
      },
      { status: 500 }
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send: Emit = (event) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
        } catch (error) {
          // Client went away (refresh / navigation). Stop writing; workers
          // still honour request.signal below.
          closed = true;
          const code =
            error && typeof error === 'object' && 'code' in error
              ? String((error as { code?: string }).code)
              : '';
          if (code !== 'ERR_INVALID_STATE') {
            console.warn('Image-text stream write failed:', error);
          }
        }
      };

      try {
        await runFilter(fileId, model, language, apiKey, send, request.signal);
      } catch (error) {
        console.error('Image-text filter error:', error);
        send({
          type: 'error',
          error:
            error instanceof Error ? error.message : 'Failed to analyse the images'
        });
      } finally {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      }
    },
    cancel() {
      // Browser aborted the fetch — ReadableStream cancel fires here.
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no'
    }
  });
}
