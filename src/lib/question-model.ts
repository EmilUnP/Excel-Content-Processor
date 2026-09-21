import { CellData } from '@/types';

/**
 * How a question is laid out across the spreadsheet columns.
 *
 *   col 0   ID
 *   col 1   ID-Q
 *   col 2   Question text
 *   col 3   Variant 1      col 4   Code 1   (1 = correct, 0 = wrong)
 *   col 5   Variant 2      col 6   Code 2
 *   ...
 *
 * One row is one question. This module owns that knowledge so the components
 * do not each re-derive it.
 */

export const COL_ID = 0;
export const COL_ID_Q = 1;
export const COL_QUESTION = 2;
export const COL_FIRST_VARIANT = 3;

/** Code columns are 4, 6, 8, ... - every second column from 4. */
export function isCodeColumn(colIndex: number): boolean {
  return colIndex >= 4 && (colIndex - 4) % 2 === 0;
}

/** Variant columns are 3, 5, 7, ... - everything from 3 that is not a code. */
export function isVariantColumn(colIndex: number): boolean {
  return colIndex >= COL_FIRST_VARIANT && !isCodeColumn(colIndex);
}

/** "Variant 1" for column 3, "Variant 2" for column 5, and so on. */
export function variantLabel(colIndex: number): string {
  return `Variant ${Math.floor((colIndex - COL_FIRST_VARIANT) / 2) + 1}`;
}

/** A code cell marks the correct answer with 1 (in any decimal spelling). */
export function isCorrectCode(cell: CellData | null | undefined): boolean {
  if (!cell || cell.isEmpty) return false;
  const value = cell.cleaned.trim();
  return value === '1' || value === '1.0' || value === '1.00';
}

/** Pulls the `<img>` tags out of a cell's original HTML. */
export function extractImageTags(html: string | undefined): string[] {
  if (!html) return [];
  return html.match(/<img[^>]*>/g) || [];
}

// ============================================================================
// IMAGE ANALYSIS
// ============================================================================

/** Where the images sit within a question. */
export type ImageLocation = 'question' | 'variants' | 'both';

export interface ImageVariant {
  label: string;
  colIndex: number;
  cell: CellData;
  isCorrect: boolean;
  imageCount: number;
}

export interface ImageQuestion {
  /** Zero-based row in the sheet; +1 for the number shown in the table. */
  rowIndex: number;
  id: string;
  idQ: string;
  questionCell: CellData | null;
  questionImageCount: number;
  variants: ImageVariant[];
  location: ImageLocation;
  imageCount: number;
}

export interface ImageQuestionReport {
  questions: ImageQuestion[];
  stats: {
    totalQuestions: number;
    withImages: number;
    questionOnly: number;
    variantsOnly: number;
    both: number;
    totalImages: number;
  };
}

const cellText = (cell: CellData | null | undefined): string =>
  (cell?.cleaned || '').trim();

/**
 * Finds every question that contains at least one image.
 *
 * No AI involved: `hasImages` is already computed per cell when the file is
 * uploaded. This just groups those cells back into whole questions and records
 * whether the image belongs to the question, to the variants, or to both.
 */
export function analyzeImageQuestions(rows: (CellData | null)[][]): ImageQuestionReport {
  const questions: ImageQuestion[] = [];
  let questionOnly = 0;
  let variantsOnly = 0;
  let both = 0;
  let totalImages = 0;

  rows.forEach((row, rowIndex) => {
    if (!row) return;

    const questionCell = row[COL_QUESTION] || null;
    const questionImageCount = questionCell?.hasImages
      ? Math.max(extractImageTags(questionCell.original).length, 1)
      : 0;

    const variants: ImageVariant[] = [];
    for (let col = COL_FIRST_VARIANT; col < row.length; col++) {
      if (!isVariantColumn(col)) continue;
      const cell = row[col];
      if (!cell || cell.isEmpty) continue;

      const imageCount = cell.hasImages
        ? Math.max(extractImageTags(cell.original).length, 1)
        : 0;

      variants.push({
        label: variantLabel(col),
        colIndex: col,
        cell,
        isCorrect: isCorrectCode(row[col + 1]),
        imageCount
      });
    }

    const variantImageCount = variants.reduce((sum, v) => sum + v.imageCount, 0);
    if (questionImageCount === 0 && variantImageCount === 0) return;

    const location: ImageLocation =
      questionImageCount > 0 && variantImageCount > 0
        ? 'both'
        : questionImageCount > 0
          ? 'question'
          : 'variants';

    if (location === 'both') both++;
    else if (location === 'question') questionOnly++;
    else variantsOnly++;

    const imageCount = questionImageCount + variantImageCount;
    totalImages += imageCount;

    questions.push({
      rowIndex,
      id: cellText(row[COL_ID]),
      idQ: cellText(row[COL_ID_Q]),
      questionCell,
      questionImageCount,
      variants,
      location,
      imageCount
    });
  });

  return {
    questions,
    stats: {
      totalQuestions: rows.length,
      withImages: questions.length,
      questionOnly,
      variantsOnly,
      both,
      totalImages
    }
  };
}
