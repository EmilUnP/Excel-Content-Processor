import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { ImageTextResult } from './image-text-service';

/**
 * Remembers what the vision model said about each image.
 *
 * Every classification is a billed API call, and the same picture turns up
 * again when a file is re-analysed, re-uploaded or translated. Keying on the
 * image bytes rather than on a file or row means an image is paid for once,
 * ever - across files as well as across runs.
 *
 * The model is part of the key: a different model may judge differently, so
 * switching models re-analyses rather than trusting the old verdict.
 */

/**
 * Where the verdicts live. Overridable with IMAGE_TEXT_CACHE_PATH so a test run
 * can point at a scratch file instead of discarding real, already-paid-for
 * results.
 */
const CACHE_PATH =
  process.env.IMAGE_TEXT_CACHE_PATH ||
  path.join(process.cwd(), 'data', 'image-text-cache.json');

interface CacheEntry extends Omit<ImageTextResult, 'language'> {
  /** Absent in entries written before language detection was added. */
  language?: ImageTextResult['language'];
  model: string;
  analyzedAt: string;
}

type CacheFile = Record<string, CacheEntry>;

/** Stable id for an image: sha256 of its base64 payload. */
export function imageKey(dataUrl: string, model: string): string {
  const payload = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const hash = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32);
  return `${model}:${hash}`;
}

export async function loadCache(): Promise<CacheFile> {
  try {
    const raw = await fs.readFile(CACHE_PATH, 'utf-8');
    return JSON.parse(raw) as CacheFile;
  } catch {
    // Missing or unreadable cache is not an error - start empty.
    return {};
  }
}

export async function saveCache(cache: CacheFile): Promise<void> {
  try {
    await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
    await fs.writeFile(CACHE_PATH, JSON.stringify(cache), 'utf-8');
  } catch (error) {
    // A cache that cannot be written costs money on the next run, but it must
    // never fail the request that produced good results.
    console.warn('Could not write the image-text cache:', error);
  }
}

/**
 * Reads a verdict, or null when there is nothing usable.
 *
 * `needLanguage` matters for entries written before language detection existed:
 * they have a kind but no language. Returning one of those for a run that
 * filters by language would silently drop every image, so it counts as a miss
 * and the image is re-read. Runs that ignore language still use them.
 */
export function readEntry(
  cache: CacheFile,
  key: string,
  needLanguage = false
): ImageTextResult | null {
  const hit = cache[key];
  if (!hit) return null;
  if (needLanguage && !hit.language) return null;
  return { kind: hit.kind, language: hit.language ?? 'none', sample: hit.sample };
}

export function writeEntry(
  cache: CacheFile,
  key: string,
  model: string,
  result: ImageTextResult
): void {
  cache[key] = { ...result, model, analyzedAt: new Date().toISOString() };
}
