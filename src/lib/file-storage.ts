import fs from 'fs/promises';
import path from 'path';
import { FileData } from '@/types';

const DATA_DIR = path.join(process.cwd(), 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');

// Ensure directories exist
async function ensureDirectories() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(FILES_DIR, { recursive: true });
}

// Cache directory existence to avoid repeated checks
let directoriesEnsured = false;

async function ensureDirectoriesOnce(): Promise<void> {
  if (!directoriesEnsured) {
    await ensureDirectories();
    directoriesEnsured = true;
  }
}

/**
 * Small cache of parsed files, validated against the file's mtime and size.
 *
 * A stored file is many megabytes of JSON, and the same file gets re-read on
 * page load, before translating, before cleaning and again on every refresh.
 * Re-parsing it each time was pure repeated work. An entry is dropped as soon
 * as the file on disk changes, and only the two most recently used files are
 * kept so memory stays bounded.
 */
const FILE_CACHE_LIMIT = 2;
const fileCache = new Map<string, { mtimeMs: number; size: number; data: FileData }>();

function cacheGet(fileId: string, mtimeMs: number, size: number): FileData | null {
  const hit = fileCache.get(fileId);
  if (!hit || hit.mtimeMs !== mtimeMs || hit.size !== size) return null;
  // Move to the most-recently-used end
  fileCache.delete(fileId);
  fileCache.set(fileId, hit);
  return hit.data;
}

function cacheSet(fileId: string, mtimeMs: number, size: number, data: FileData): void {
  fileCache.delete(fileId);
  fileCache.set(fileId, { mtimeMs, size, data });
  while (fileCache.size > FILE_CACHE_LIMIT) {
    const oldest = fileCache.keys().next().value;
    if (oldest === undefined) break;
    fileCache.delete(oldest);
  }
}

// File operations
export class FileStorage {
  static async saveFile(fileId: string, data: FileData): Promise<void> {
    await ensureDirectoriesOnce();
    const filePath = path.join(FILES_DIR, `${fileId}.json`);
    // Use compact JSON (no pretty printing) for ~3-5x faster writes and ~50% smaller files
    await fs.writeFile(filePath, JSON.stringify(data), 'utf-8');
    // Drop any cached copy: the next read re-parses what is actually on disk.
    fileCache.delete(fileId);
  }

  static async getFile(fileId: string): Promise<FileData | null> {
    try {
      await ensureDirectoriesOnce();
      const filePath = path.join(FILES_DIR, `${fileId}.json`);

      const stats = await fs.stat(filePath);
      const cached = cacheGet(fileId, stats.mtimeMs, stats.size);
      if (cached) return cached;

      const data = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(data) as FileData;
      cacheSet(fileId, stats.mtimeMs, stats.size, parsed);
      return parsed;
    } catch (error) {
      return null;
    }
  }

  static async deleteFile(fileId: string): Promise<void> {
    try {
      // No need to check directories for deletion
      const filePath = path.join(FILES_DIR, `${fileId}.json`);
      await fs.unlink(filePath);
    } catch (error) {
      // File doesn't exist, ignore
    } finally {
      fileCache.delete(fileId);
    }
  }
}
