import { NextRequest, NextResponse } from 'next/server';
import { FileStorage } from '@/lib/file-storage';
import { CellData, FileData } from '@/types';
import { analyzeImageQuestions, extractImageTags } from '@/lib/question-model';
import { getDefaultImageTranslateModel } from '@/lib/model-config';
import {
  createImageClient,
  sizeOfDataUrl,
  translateImage
} from '@/lib/image-translate-service';
import {
  TranslatedImageEntry,
  loadTranslateIndex,
  readTranslatedImage,
  translationKey,
  writeTranslatedImage
} from '@/lib/image-translate-cache';

/**
 * Step 3: redraws each image with its text translated.
 *
 * POST /api/files/translate-images
 *   body: { fileId, targetLanguage, model?, limit? }
 *
 * Streams NDJSON progress, like step 2, because each image takes seconds and a
 * whole file takes minutes:
 *
 *   {"type":"start","total":67,"cached":12,"model":"...","estimatedCost":7.65}
 *   {"type":"progress","done":13,"total":67,"spent":0.42}
 *   {"type":"done","data":{...},"stats":{...}}
 *
 * Money is the defining constraint here - one edit costs around 14 cents on the
 * Pro model. So: every result is cached by image + language + model, `limit`
 * exists to let a few images be checked before committing to a whole file, and
 * the running total is reported as it is spent rather than only at the end.
 *
 * The original image is never discarded. It stays in the cell's `imageData`,
 * and the source file is untouched - the result is a new `<fileId>_imgtr_<lang>`.
 */

/**
 * `limit` value meaning "only images already in the cache - spend nothing".
 * Not exported: a Next.js route file may only export route handlers.
 */
const CACHED_ONLY = -1;

const IMG_TAG_RE = /<img[^>]*>/g;
const SRC_RE = /src\s*=\s*"(data:image\/[^"]+)"/i;

type Emit = (event: Record<string, unknown>) => void;

/**
 * Swaps the pictures inside a cell's HTML for their translated versions.
 *
 * The replacement carries explicit width/height taken from the ORIGINAL image.
 * Editing models return their own canvas size - typically a 4x upscale - so
 * without this the exported document would reflow. Pinning the display size
 * keeps every layout identical while leaving the sharper pixels intact.
 */
/** One finished translation: the picture plus what is known about it. */
type Translated = { dataUrl: string; meta: Omit<TranslatedImageEntry, 'file'> };

function replaceImages(
  html: string,
  translations: Map<string, Translated>
): { html: string; replaced: number } {
  let replaced = 0;
  const out = html.replace(IMG_TAG_RE, (tag) => {
    const match = tag.match(SRC_RE);
    if (!match) return tag;
    const hit = translations.get(match[1]);
    if (!hit) return tag;
    replaced++;
    const size =
      hit.meta.sourceWidth && hit.meta.sourceHeight
        ? ` width="${hit.meta.sourceWidth}" height="${hit.meta.sourceHeight}"`
        : '';
    return `<img src="${hit.dataUrl}"${size} data-translated="1">`;
  });
  return { html: out, replaced };
}

async function runTranslate(
  fileId: string,
  targetLanguage: string,
  model: string,
  limit: number,
  apiKey: string,
  send: Emit
) {
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

  // Every distinct picture, in the order questions appear, so a `limit` run
  // covers the first questions rather than a random scattering.
  const uniqueUrls: string[] = [];
  const seen = new Set<string>();
  for (const question of report.questions) {
    for (const cell of rows[question.rowIndex]) {
      if (!cell || !cell.hasImages) continue;
      for (const tag of extractImageTags(cell.original)) {
        const match = tag.match(SRC_RE);
        if (!match) continue;
        const key = translationKey(match[1], targetLanguage, model);
        if (seen.has(key)) continue;
        seen.add(key);
        uniqueUrls.push(match[1]);
      }
    }
  }

  // Only the index is read up front - metadata, no pictures. Individual images
  // are loaded on demand below, so an unused cache entry costs nothing.
  const index = await loadTranslateIndex();

  // limit === CACHED_ONLY builds a viewable file from images that have already
  // been paid for, without calling the API at all. It exists because the
  // results otherwise live only in the cache, where the app cannot show them.
  const isCachedOnly = limit === CACHED_ONLY;
  const selected = isCachedOnly
    ? uniqueUrls.filter((url) => index[translationKey(url, targetLanguage, model)])
    : limit > 0
      ? uniqueUrls.slice(0, limit)
      : uniqueUrls;

  if (isCachedOnly && selected.length === 0) {
    send({
      type: 'error',
      error:
        `Nothing has been translated into ${targetLanguage} with this model yet, ` +
        `so there is nothing to show for free. Run it on a few images first.`
    });
    return;
  }

  const translations = new Map<string, Translated>();
  const pending: string[] = [];

  for (const url of selected) {
    const key = translationKey(url, targetLanguage, model);
    const meta = index[key];
    const cached = meta ? await readTranslatedImage(index, key) : null;
    if (meta && cached) translations.set(url, { dataUrl: cached, meta });
    else pending.push(url);
  }

  const fromCache = selected.length - pending.length;
  send({
    type: 'start',
    total: selected.length,
    cached: fromCache,
    skipped: uniqueUrls.length - selected.length,
    model,
    targetLanguage
  });

  const client = createImageClient(apiKey);
  let done = fromCache;
  let translated = 0;
  let failed = 0;
  let spent = 0;

  // Images are redrawn one at a time on purpose. These calls are billed per
  // image and take seconds each; running them in parallel would multiply the
  // damage of a wrong model or language before anyone could stop it.
  for (const url of pending) {
    try {
      const source = sizeOfDataUrl(url);
      const result = await translateImage(url, targetLanguage, client, model);
      const meta: Omit<TranslatedImageEntry, 'file'> = {
        width: result.width,
        height: result.height,
        sourceWidth: source?.width ?? 0,
        sourceHeight: source?.height ?? 0,
        model,
        targetLanguage,
        cost: result.cost,
        translatedAt: new Date().toISOString()
      };
      translations.set(url, { dataUrl: result.dataUrl, meta });
      translated++;
      spent += result.cost;
      // Saved as soon as it arrives: a crash or a stop must not throw away work
      // that has already been paid for. One picture is written, not the whole
      // cache, so this stays cheap however many images the run covers.
      await writeTranslatedImage(
        index,
        translationKey(url, targetLanguage, model),
        result.dataUrl,
        meta
      );
    } catch (error) {
      console.error('Image translation failed:', error);
      failed++;
    }
    done++;
    send({ type: 'progress', done, total: selected.length, spent: Number(spent.toFixed(4)) });
  }

  if (translations.size === 0) {
    send({ type: 'error', error: 'No image could be translated.' });
    return;
  }

  // Rebuild the cells, swapping in the translated pictures.
  let cellsChanged = 0;
  const cells: CellData[] = file.cells.map((cell) => {
    if (!cell.hasImages || !cell.original) return cell;
    const { html, replaced } = replaceImages(cell.original, translations);
    if (!replaced) return cell;
    cellsChanged++;
    return {
      ...cell,
      original: html,
      // The untouched picture stays here, so the original is always recoverable.
      imageData: cell.imageData
    };
  });

  const outId = `${fileId}_imgtr_${targetLanguage}`;
  const out: FileData = {
    id: outId,
    name: `${file.name} (images in ${targetLanguage})`,
    uploadDate: new Date().toISOString(),
    totalRows: file.totalRows,
    totalColumns: file.totalColumns,
    cells
  };

  await FileStorage.saveFile(outId, out);

  const stats = {
    questionsWithImages: report.stats.withImages,
    uniqueImages: uniqueUrls.length,
    attempted: selected.length,
    translated,
    fromCache,
    failed,
    skipped: uniqueUrls.length - selected.length,
    cellsChanged,
    spent: Number(spent.toFixed(4)),
    model,
    targetLanguage
  };

  console.log('Image translation:', JSON.stringify(stats));
  send({ type: 'done', data: out, stats });
}

export async function POST(request: NextRequest) {
  const {
    fileId,
    targetLanguage,
    model = getDefaultImageTranslateModel(),
    limit = 0
  } = await request.json();

  if (!fileId) {
    return NextResponse.json({ success: false, error: 'File ID is required' }, { status: 400 });
  }
  if (!targetLanguage) {
    return NextResponse.json(
      { success: false, error: 'A target language is required' },
      { status: 400 }
    );
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
      const send: Emit = (event) =>
        controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
      try {
        await runTranslate(fileId, targetLanguage, model, Number(limit) || 0, apiKey, send);
      } catch (error) {
        console.error('Image translation error:', error);
        send({
          type: 'error',
          error: error instanceof Error ? error.message : 'Failed to translate the images'
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
      'X-Accel-Buffering': 'no'
    }
  });
}
