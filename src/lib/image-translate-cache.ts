import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

/**
 * Stores translated images so a picture is redrawn once, ever.
 *
 * This matters more here than anywhere else in the app: one edit costs around
 * 14 cents, so a careless re-run of a 128-image file is eighteen dollars.
 * Keying on the image bytes means the same picture in another file, or after a
 * re-upload, is free. Target language and model are part of the key - a
 * Russian-to-Azerbaijani edit is not a Russian-to-English one, and a different
 * model draws differently.
 *
 * LAYOUT: one PNG per image, plus a small JSON index of metadata.
 *
 * The first version kept everything in a single JSON and rewrote it after each
 * image, so that the work already paid for survived a crash. Each entry holds a
 * full PNG, about 1 MB. Rewriting a growing file 128 times means ~8 GB of disk
 * writes for one run, and a 126 MB parse before the run can even start. Writing
 * each image once and keeping only metadata in the index makes both linear:
 * 126 MB written in total, and a ~32 KB index to read.
 */

const CACHE_DIR =
  process.env.IMAGE_TRANSLATE_CACHE_DIR ||
  path.join(process.cwd(), 'data', 'translated-images');

const INDEX_PATH = path.join(CACHE_DIR, 'index.json');

/** The single-file cache used before this change, migrated on first use. */
const LEGACY_PATH =
  process.env.IMAGE_TRANSLATE_CACHE_PATH ||
  path.join(process.cwd(), 'data', 'image-translate-cache.json');

/** Metadata only. The picture itself lives in its own file. */
export interface TranslatedImageEntry {
  width: number;
  height: number;
  /** Size of the source, so the result can be shown at the original scale. */
  sourceWidth: number;
  sourceHeight: number;
  model: string;
  targetLanguage: string;
  cost: number;
  translatedAt: string;
  /** File name inside the cache directory. */
  file: string;
}

export type TranslateIndex = Record<string, TranslatedImageEntry>;

/** Identity of one translation job: this picture, this language, this model. */
export function translationKey(dataUrl: string, targetLanguage: string, model: string): string {
  const payload = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const hash = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32);
  return `${model}:${targetLanguage}:${hash}`;
}

/** A key contains "/" and ":", so the file is named after its digest. */
function fileNameFor(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 32) + '.png';
}

async function readIndex(): Promise<TranslateIndex> {
  try {
    return JSON.parse(await fs.readFile(INDEX_PATH, 'utf-8')) as TranslateIndex;
  } catch {
    return {};
  }
}

async function writeIndex(index: TranslateIndex): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(INDEX_PATH, JSON.stringify(index), 'utf-8');
}

/**
 * Moves a pre-existing single-file cache into the new layout.
 *
 * Runs once. Those entries were paid for, so they are split into files rather
 * than discarded, and the old file is renamed rather than deleted.
 */
async function migrateLegacy(index: TranslateIndex): Promise<TranslateIndex> {
  let legacy: Record<string, TranslatedImageEntry & { dataUrl?: string }>;
  try {
    legacy = JSON.parse(await fs.readFile(LEGACY_PATH, 'utf-8'));
  } catch {
    return index; // nothing to migrate
  }

  await fs.mkdir(CACHE_DIR, { recursive: true });
  let moved = 0;

  for (const [key, entry] of Object.entries(legacy)) {
    if (index[key] || !entry?.dataUrl) continue;
    const file = fileNameFor(key);
    const bytes = Buffer.from(entry.dataUrl.slice(entry.dataUrl.indexOf(',') + 1), 'base64');
    await fs.writeFile(path.join(CACHE_DIR, file), bytes);
    const { dataUrl, ...meta } = entry;
    index[key] = { ...meta, file };
    moved++;
  }

  if (moved > 0) {
    await writeIndex(index);
    await fs.rename(LEGACY_PATH, LEGACY_PATH + '.migrated').catch(() => {});
    console.log(`Migrated ${moved} translated image(s) out of the single-file cache.`);
  }
  return index;
}

export async function loadTranslateIndex(): Promise<TranslateIndex> {
  const index = await readIndex();
  return migrateLegacy(index);
}

/** Loads one translated picture back as a data URL. */
export async function readTranslatedImage(
  index: TranslateIndex,
  key: string
): Promise<string | null> {
  const entry = index[key];
  if (!entry) return null;
  try {
    const bytes = await fs.readFile(path.join(CACHE_DIR, entry.file));
    return `data:image/png;base64,${bytes.toString('base64')}`;
  } catch {
    // The index mentions a file that is gone; treat it as a miss.
    return null;
  }
}

/**
 * Saves one translated picture and records it.
 *
 * The image is written first: an index entry pointing at a missing file would
 * read as a cache hit that yields nothing.
 */
export async function writeTranslatedImage(
  index: TranslateIndex,
  key: string,
  dataUrl: string,
  meta: Omit<TranslatedImageEntry, 'file'>
): Promise<void> {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    const file = fileNameFor(key);
    const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    await fs.writeFile(path.join(CACHE_DIR, file), bytes);
    index[key] = { ...meta, file };
    await writeIndex(index);
  } catch (error) {
    // Failing to cache costs money next time, but must never lose the result
    // that was just paid for.
    console.warn('Could not cache a translated image:', error);
  }
}

/** Total spent so far, for reporting what the cache is worth. */
export function cacheValue(index: TranslateIndex): { entries: number; spent: number } {
  const values = Object.values(index);
  return {
    entries: values.length,
    spent: values.reduce((sum, entry) => sum + (entry.cost || 0), 0)
  };
}
