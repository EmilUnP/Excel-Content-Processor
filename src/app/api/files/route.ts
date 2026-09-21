import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

// The file list must reflect what is on disk right now. Without this, a
// production build prerenders this route once and serves a frozen list.
// (Dev mode is always dynamic, so this changes nothing there.)
export const dynamic = 'force-dynamic';

interface FileListEntry {
  id: string;
  filename: string;
  name: string;
  uploadDate: string;
  totalRows: number;
  totalColumns: number;
  totalCells: number;
  isTranslated: boolean;
  language: string;
  type: 'translated' | 'original';
}

// Cached listing entries, keyed by filename and invalidated by mtime + size.
// Opening the file manager repeatedly is a common action, and nothing about a
// stored file changes unless the file itself is rewritten.
const metadataCache = new Map<string, { mtimeMs: number; size: number; entry: FileListEntry }>();

const HEADER_BYTES = 8192;
const ROW_INDEX_KEY = Buffer.from('"rowIndex":');

/**
 * Counts cells without building any objects.
 *
 * Every cell in the stored JSON starts with a "rowIndex" key, so scanning the
 * raw bytes gives an exact count. JSON.parse on a 14 MB file costs seconds and
 * allocates tens of thousands of short-lived objects; this costs milliseconds.
 */
function countCells(buffer: Buffer): number {
  let count = 0;
  let index = buffer.indexOf(ROW_INDEX_KEY, 0);
  while (index !== -1) {
    count++;
    index = buffer.indexOf(ROW_INDEX_KEY, index + ROW_INDEX_KEY.length);
  }
  return count;
}

const BACKSLASH = String.fromCharCode(92);

/** Reads a top-level string field straight out of the raw JSON header. */
function readString(header: string, key: string): string | null {
  const marker = '"' + key + '":';
  let at = header.indexOf(marker);
  if (at === -1) return null;
  at += marker.length;
  while (at < header.length && header[at] === ' ') at++;
  if (header[at] !== '"') return null;
  at++;
  const end = header.indexOf('"', at);
  if (end === -1) return null;
  const value = header.slice(at, end);
  // An escaped character would need real JSON decoding - let the caller fall back.
  return value.indexOf(BACKSLASH) === -1 ? value : null;
}

/** Reads a top-level integer field straight out of the raw JSON header. */
function readNumber(header: string, key: string): number | null {
  const marker = '"' + key + '":';
  let at = header.indexOf(marker);
  if (at === -1) return null;
  at += marker.length;
  while (at < header.length && header[at] === ' ') at++;
  let end = at;
  while (end < header.length && header[end] >= '0' && header[end] <= '9') end++;
  if (end === at) return null;
  return parseInt(header.slice(at, end), 10);
}

function describeFilename(filename: string) {
  const isTranslated = filename.includes('_translated_');
  const language = isTranslated
    ? filename.split('_translated_')[1]?.split('.')[0] || 'Unknown'
    : 'Original';
  const type: 'translated' | 'original' = isTranslated ? 'translated' : 'original';
  return { isTranslated, language, type };
}

async function readEntry(filesDir: string, filename: string): Promise<FileListEntry | null> {
  const filePath = path.join(filesDir, filename);
  const stats = await fs.stat(filePath);

  const cached = metadataCache.get(filename);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.entry;
  }

  // Read as a Buffer: no 14 MB UTF-8 string, no parse.
  const buffer = await fs.readFile(filePath);
  const header = buffer.toString('utf-8', 0, Math.min(HEADER_BYTES, buffer.length));
  const { isTranslated, language, type } = describeFilename(filename);

  const id = readString(header, 'id');
  const name = readString(header, 'name');
  const uploadDate = readString(header, 'uploadDate');
  const totalRows = readNumber(header, 'totalRows');
  const totalColumns = readNumber(header, 'totalColumns');

  let entry: FileListEntry;

  if (id && name && uploadDate && totalRows !== null && totalColumns !== null) {
    entry = {
      id,
      filename,
      name,
      uploadDate,
      totalRows,
      totalColumns,
      totalCells: countCells(buffer),
      isTranslated,
      language,
      type
    };
  } else {
    // Fallback for any file whose header does not match the expected shape
    // (for example a name containing escaped quotes): parse it the slow way.
    const fileData = JSON.parse(buffer.toString('utf-8'));
    entry = {
      id: fileData.id,
      filename,
      name: fileData.name,
      uploadDate: fileData.uploadDate,
      totalRows: fileData.totalRows,
      totalColumns: fileData.totalColumns,
      totalCells: fileData.cells?.length || 0,
      isTranslated,
      language,
      type
    };
  }

  metadataCache.set(filename, { mtimeMs: stats.mtimeMs, size: stats.size, entry });
  return entry;
}

export async function GET() {
  try {
    const filesDir = path.join(process.cwd(), 'data', 'files');
    
    // Check if directory exists
    try {
      await fs.access(filesDir);
    } catch {
      return NextResponse.json({ files: [] });
    }

    const files = await fs.readdir(filesDir);
    const jsonFiles = files.filter(file => file.endsWith('.json'));

    // Read every file concurrently instead of one after another.
    const results = await Promise.all(
      jsonFiles.map(async (file) => {
        try {
          return await readEntry(filesDir, file);
        } catch (error) {
          console.error(`Error reading file ${file}:`, error);
          return null;
        }
      })
    );

    const fileList = results.filter((entry): entry is FileListEntry => entry !== null);

    // Drop cache entries for files that no longer exist
    if (metadataCache.size > jsonFiles.length) {
      const present = new Set(jsonFiles);
      for (const key of Array.from(metadataCache.keys())) {
        if (!present.has(key)) metadataCache.delete(key);
      }
    }

    // Sort by upload date (newest first)
    fileList.sort((a, b) => new Date(b.uploadDate).getTime() - new Date(a.uploadDate).getTime());

    return NextResponse.json({ files: fileList });
  } catch (error) {
    console.error('Error listing files:', error);
    return NextResponse.json({ error: 'Failed to list files' }, { status: 500 });
  }
}
