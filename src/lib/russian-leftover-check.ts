import { CellData } from '@/types';
import { COL_ID, COL_ID_Q, isCodeColumn } from './question-model';

/**
 * Simple post-translation check: any Cyrillic (Russian alphabet) left in
 * translated cells means the translation is incomplete.
 *
 * Skips ID columns and answer-code columns. Does not run when the target
 * language is Russian.
 */

const CYRILLIC = /[а-яёА-ЯЁ]/;

export interface RussianLeftoverHit {
  rowIndex: number;
  colIndex: number;
  idQ: string;
  preview: string;
  cyrillicCount: number;
}

export interface RussianLeftoverReport {
  /** True when no Cyrillic was found in translated cells. */
  ok: boolean;
  hitCount: number;
  hits: RussianLeftoverHit[];
  scannedCells: number;
}

function plain(text: string): string {
  if (!text) return '';
  return text
    .replace(/<img[^>]*>/gi, ' ')
    .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=\s]+/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function shouldSkipTarget(targetLanguage: string): boolean {
  return /^ru|rus|рус/i.test(targetLanguage.trim());
}

function shouldScanCell(colIndex: number): boolean {
  if (colIndex === COL_ID || colIndex === COL_ID_Q) return false;
  if (isCodeColumn(colIndex)) return false;
  return true;
}

/**
 * Scan cleaned (translated) cells for leftover Russian letters.
 * Caps listed hits so the UI / CLI stay readable.
 */
export function findRussianLeftovers(
  cells: CellData[],
  targetLanguage: string,
  maxHits = 50
): RussianLeftoverReport {
  if (shouldSkipTarget(targetLanguage)) {
    return { ok: true, hitCount: 0, hits: [], scannedCells: 0 };
  }

  const idQByRow = new Map<number, string>();
  for (const cell of cells) {
    if (cell.colIndex === COL_ID_Q) {
      const id = plain(cell.cleaned || cell.original || '');
      if (id) idQByRow.set(cell.rowIndex, id);
    }
  }

  const hits: RussianLeftoverHit[] = [];
  let hitCount = 0;
  let scannedCells = 0;

  for (const cell of cells) {
    if (!shouldScanCell(cell.colIndex)) continue;
    if (cell.isEmpty) continue;

    const text = plain(cell.cleaned || '');
    if (!text) continue;
    scannedCells++;

    if (!CYRILLIC.test(text)) continue;

    const cyrillicCount = (text.match(/[а-яёА-ЯЁ]/g) || []).length;
    hitCount++;
    if (hits.length < maxHits) {
      hits.push({
        rowIndex: cell.rowIndex,
        colIndex: cell.colIndex,
        idQ: idQByRow.get(cell.rowIndex) || `row-${cell.rowIndex + 1}`,
        preview: text.slice(0, 120),
        cyrillicCount
      });
    }
  }

  return {
    ok: hitCount === 0,
    hitCount,
    hits,
    scannedCells
  };
}
