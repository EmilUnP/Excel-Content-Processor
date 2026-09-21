/**
 * After translation: scan for leftover Russian (Cyrillic) letters.
 *
 * If any are found → translation has a problem.
 * If none → everything looks clean for this check.
 *
 * Usage:
 *   npm run check:russian
 *   npm run check:russian -- data/files/some_translated_az.json
 */
import fs from 'fs';
import path from 'path';
import { findRussianLeftovers } from '../src/lib/russian-leftover-check';
import { CellData } from '../src/types';

function resolveInputPath(arg: string): string {
  const resolved = path.resolve(arg);
  if (fs.existsSync(resolved)) return resolved;

  // Common mistake: data/foo.json instead of data/files/foo.json
  const underFiles = path.resolve('data/files', path.basename(arg));
  if (fs.existsSync(underFiles)) return underFiles;

  const underData = path.resolve('data', path.basename(arg));
  if (fs.existsSync(underData)) return underData;

  throw new Error(
    `File not found: ${resolved}\n` +
      `  Tip: translated files live in data/files/\n` +
      `  Try: npm run check:russian\n` +
      `  Or:  npm run check:russian -- data/files/${path.basename(arg)}`
  );
}

function loadCells(filePath: string): { cells: CellData[]; targetLanguage: string } {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const cells = (Array.isArray(raw?.cells) ? raw.cells : raw) as CellData[];
  const name = String(raw?.name || path.basename(filePath));
  const fromName = name.match(/_translated_([a-z]{2,5})/i)?.[1];
  const targetLanguage = fromName || 'az';
  return { cells, targetLanguage };
}

function listTranslatedFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.includes('_translated_') && f.endsWith('.json'))
    .map((f) => path.join(dir, f));
}

function auditFile(filePath: string): boolean {
  const { cells, targetLanguage } = loadCells(filePath);
  const report = findRussianLeftovers(cells, targetLanguage);

  console.log(`\n${path.basename(filePath)}`);
  console.log(`  scanned ${report.scannedCells} cells (target: ${targetLanguage})`);

  if (report.ok) {
    console.log('  OK — no Russian alphabet found. Translation looks clean.');
    return true;
  }

  console.log(
    `  PROBLEM — found Russian letters in ${report.hitCount} cell(s):`
  );
  for (const hit of report.hits) {
    console.log(
      `    - ${hit.idQ} (row ${hit.rowIndex + 1}, col ${hit.colIndex}) ` +
        `[${hit.cyrillicCount} Cyrillic chars]: ${hit.preview}`
    );
  }
  if (report.hitCount > report.hits.length) {
    console.log(`    … and ${report.hitCount - report.hits.length} more`);
  }
  return false;
}

function main(): void {
  const arg = process.argv[2];
  const files = arg
    ? [resolveInputPath(arg)]
    : listTranslatedFiles(path.resolve('data/files'));

  if (files.length === 0) {
    console.log('No translated JSON files found under data/files.');
    console.log('Pass a file path, or translate first then re-run.');
    process.exitCode = 0;
    return;
  }

  let allOk = true;
  for (const file of files) {
    try {
      if (!auditFile(file)) allOk = false;
    } catch (error) {
      console.error(`Could not check ${file}:`, error);
      allOk = false;
    }
  }

  console.log(
    allOk
      ? '\nResult: PERFECT — no Russian leftovers.'
      : '\nResult: PROBLEMS FOUND — re-translate the listed rows/cells.'
  );
  process.exitCode = allOk ? 0 : 1;
}

main();
