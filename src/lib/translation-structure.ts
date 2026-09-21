import { CellData } from '@/types';
import { COL_ID_Q, COL_QUESTION, isVariantColumn } from './question-model';

/**
 * Detects when a batch translation remaps cell content incorrectly:
 * - options pasted into the question
 * - question body swapped into a variant column
 * - leftover Cyrillic when the target is not Russian (partial translation)
 *
 * Matching / chronology rows that already store their item list inside the
 * question column are only flagged when the *source* plain text did not have
 * those markers, or when lengths clearly swapped across columns.
 */

/** Strip HTML / image payloads so marker counts compare real wording. */
export function plainTextForCompare(text: string): string {
  if (!text) return '';
  return text
    .replace(/<img[^>]*>/gi, ' ')
    .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=\s]+/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

export function countCyrillic(text: string): number {
  return (text.match(/[а-яёА-ЯЁ]/g) || []).length;
}

/**
 * Removes era / Latin abbreviations that look like option markers
 * (`e.ə.`, `н.э.`, `i.e.`) so they are not counted as choices.
 */
function stripFalseOptionLooks(text: string): string {
  return text
    .replace(/\be\.?\s*ə\./gi, ' ')
    .replace(/\bдо\s+н\.?\s*э\.?/gi, ' ')
    .replace(/\bn\.?\s*э\.?/gi, ' ')
    .replace(/\bи\.\s*т\.\s*[дп]\./gi, ' ')
    .replace(/\bi\.?\s*e\./gi, ' ')
    .replace(/\bt\.?\s*e\./gi, ' ')
    .replace(/\be\.?\s*g\./gi, ' ');
}

/** Counts markers that look like multiple-choice / ordering options. */
export function countOptionMarkers(text: string): number {
  if (!text) return 0;
  const cleaned = stripFalseOptionLooks(text);
  // Optional space before . or ) — sources often have "a )" / "b ."
  const numbered = cleaned.match(/(?:^|[\s:;(\[])(?:[1-9]|10)\s*[.)]\s*\S/gm) || [];
  const lettered = cleaned.match(/(?:^|[\s:;(\[])[a-e]\s*[.)]\s*\S/gim) || [];
  const roman = cleaned.match(/(?:^|[\s:;(\[])[IVX]{1,4}\s*[.)]\s*\S/gm) || [];
  return numbered.length + lettered.length + roman.length;
}

/**
 * True when the translation looks like it absorbed other cells' options.
 */
export function looksContentMerged(source: string, output: string): boolean {
  const src = plainTextForCompare(source);
  const out = plainTextForCompare(output);
  if (!src || !out || out === src) return false;

  const srcMarkers = countOptionMarkers(src);
  const outMarkers = countOptionMarkers(out);
  const gained = outMarkers - srcMarkers;

  if (gained >= 2 && outMarkers >= 2) return true;
  if (gained >= 1 && out.length > src.length * 2.2 && outMarkers >= 2) return true;

  // Trailing "1." leaked from the first variant onto the question.
  if (
    srcMarkers === 0 &&
    /(?:^|[\s:;])\s*[1-9][.)]\s*$/.test(out) &&
    out.length < src.length * 1.5
  ) {
    return true;
  }

  return false;
}

/**
 * True when output still contains substantial Russian while the target is not.
 *
 * Covers the failure where a cell is only half-translated (Azerbaijani + leftover
 * Cyrillic). Exact source===output is handled separately by looksUntranslated.
 */
export function looksPartiallyUntranslated(
  source: string,
  output: string,
  targetLanguage: string
): boolean {
  if (/^ru|rus|рус/i.test(targetLanguage.trim())) return false;

  const src = plainTextForCompare(source);
  const out = plainTextForCompare(output);
  if (!src || !out) return false;

  const srcCyr = countCyrillic(src);
  if (srcCyr < 6) return false;

  const outCyr = countCyrillic(out);
  if (outCyr < 5) return false;

  // Mixed language in one cell: enough Latin/AZ letters and enough Cyrillic left.
  const outLat = (out.match(/[a-zA-ZəğıöüşçƏĞİÖÜŞÇäöü]/g) || []).length;
  if (outCyr >= 6 && outLat >= 10) return true;

  // Mostly still Russian (weak / truncated translation), even without Latin mix.
  if (outCyr >= 12 && outCyr >= srcCyr * 0.35 && out !== src) return true;

  return false;
}

/**
 * Question stem looks like it was swapped into another cell (or gutted).
 *
 * Pattern from real rows: question column shrinks to a short fragment while a
 * variant column balloons to roughly the original question length (often ending
 * with "müəyyən edin" / similar).
 */
export function looksQuestionVariantSwap(
  qSource: string,
  qOut: string,
  vSource: string,
  vOut: string
): boolean {
  const qs = plainTextForCompare(qSource).length;
  const qo = plainTextForCompare(qOut).length;
  const vs = plainTextForCompare(vSource).length;
  const vo = plainTextForCompare(vOut).length;

  if (qs < 40) return false;

  const questionShrunk = qo < qs * 0.45 && qo < qs - 30;
  const variantGrew = vo > Math.max(vs * 1.8, vs + 40);
  const variantLooksLikeQuestion =
    vo >= qs * 0.55 && vo <= qs * 1.8 && vo > qo * 2;

  return questionShrunk && variantGrew && variantLooksLikeQuestion;
}

/**
 * Indices whose batch output moved / swapped / left Cyrillic in cells.
 */
export function findCrossCellMergeIndices(
  cells: CellData[],
  sources: string[],
  translations: string[],
  targetLanguage?: string
): Set<number> {
  const bad = new Set<number>();
  const byRow = new Map<number, number[]>();

  cells.forEach((cell, i) => {
    const list = byRow.get(cell.rowIndex) || [];
    list.push(i);
    byRow.set(cell.rowIndex, list);
  });

  for (const indices of byRow.values()) {
    const qIdx = indices.find((i) => cells[i].colIndex === COL_QUESTION);
    if (qIdx === undefined) continue;

    if (looksContentMerged(sources[qIdx], translations[qIdx])) {
      bad.add(qIdx);
    }

    for (const i of indices) {
      if (!isVariantColumn(cells[i].colIndex)) continue;
      const srcLen = plainTextForCompare(sources[i]).length;
      const outLen = plainTextForCompare(translations[i]).length;

      if (
        looksQuestionVariantSwap(
          sources[qIdx],
          translations[qIdx],
          sources[i],
          translations[i]
        )
      ) {
        bad.add(qIdx);
        bad.add(i);
      }

      if (srcLen < 8) continue;

      const questionGrew =
        plainTextForCompare(translations[qIdx]).length >
        plainTextForCompare(sources[qIdx]).length * 1.6;

      if (outLen === 0 && questionGrew) {
        bad.add(i);
        bad.add(qIdx);
      } else if (
        outLen < srcLen * 0.25 &&
        questionGrew &&
        looksContentMerged(sources[qIdx], translations[qIdx])
      ) {
        bad.add(i);
      }
    }
  }

  for (let i = 0; i < translations.length; i++) {
    if (looksContentMerged(sources[i], translations[i])) {
      bad.add(i);
    }
    if (
      targetLanguage &&
      looksPartiallyUntranslated(sources[i], translations[i], targetLanguage)
    ) {
      bad.add(i);
    }
  }

  return bad;
}

export interface MergedQuestionHit {
  rowIndex: number;
  idQ: string;
  reason: string;
  questionPreview: string;
  sourceMarkers: number;
  translatedMarkers: number;
  sourceLen: number;
  translatedLen: number;
}

/**
 * Scans a translated file against its source cells (same row/col keys).
 */
export function findMergedQuestionsInFile(
  cells: CellData[],
  targetLanguage = 'az'
): MergedQuestionHit[] {
  const byKey = new Map<string, CellData>();
  for (const cell of cells) {
    byKey.set(`${cell.rowIndex}:${cell.colIndex}`, cell);
  }

  const rows = new Set(cells.map((c) => c.rowIndex));
  const hits: MergedQuestionHit[] = [];

  for (const rowIndex of rows) {
    const question = byKey.get(`${rowIndex}:${COL_QUESTION}`);
    if (!question || question.isEmpty) continue;

    const source = plainTextForCompare(question.original || '');
    const translated = plainTextForCompare(question.cleaned || '');
    if (!source || !translated) continue;

    const srcMarkers = countOptionMarkers(source);
    const outMarkers = countOptionMarkers(translated);

    let reason = '';
    if (looksContentMerged(source, translated)) {
      reason = 'question gained option markers vs original';
    } else if (
      srcMarkers === 0 &&
      /(?:^|[\s:;])\s*[1-9][.)]\s*$/.test(translated)
    ) {
      reason = 'question ends with a lone option marker (e.g. "1.")';
    } else if (looksPartiallyUntranslated(source, translated, targetLanguage)) {
      reason = 'question still contains substantial Cyrillic (partial translation)';
    }

    if (!reason) {
      for (let col = 3; col < 40; col++) {
        if (!isVariantColumn(col)) continue;
        const variant = byKey.get(`${rowIndex}:${col}`);
        if (!variant) continue;
        const vSrc = plainTextForCompare(variant.original || '');
        const vOut = plainTextForCompare(variant.cleaned || '');

        if (
          looksQuestionVariantSwap(
            question.original || '',
            question.cleaned || '',
            variant.original || '',
            variant.cleaned || ''
          )
        ) {
          reason = 'question text appears swapped into a variant column';
          break;
        }

        if (
          vSrc.length >= 12 &&
          vOut.length === 0 &&
          outMarkers >= srcMarkers + 2 &&
          translated.length > source.length * 1.4
        ) {
          reason = 'variant emptied while question gained option markers';
          break;
        }

        if (looksPartiallyUntranslated(vSrc, vOut, targetLanguage)) {
          reason = `variant col ${col} still contains substantial Cyrillic`;
          break;
        }
      }
    }

    if (!reason) continue;

    const idQCell = byKey.get(`${rowIndex}:${COL_ID_Q}`);
    hits.push({
      rowIndex,
      idQ: (idQCell?.cleaned || idQCell?.original || '').trim() || `row-${rowIndex}`,
      reason,
      questionPreview: translated.slice(0, 160),
      sourceMarkers: srcMarkers,
      translatedMarkers: outMarkers,
      sourceLen: source.length,
      translatedLen: translated.length
    });
  }

  return hits;
}
