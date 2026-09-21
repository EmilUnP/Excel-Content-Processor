import { NextRequest, NextResponse } from 'next/server';
import { FileStorage } from '@/lib/file-storage';
import { CellData, FileData } from '@/types';
import { analyzeImageQuestions } from '@/lib/question-model';

/**
 * Keeps only the questions that contain an image.
 *
 * POST /api/files/images   body: { fileId }
 *
 * This is an action on the stored data, not an export: it writes a new JSON
 * file next to the original containing just the image questions, and returns it
 * so the app can switch to it.
 *
 * The source file is left untouched - the result is saved under
 * `<fileId>_images` - so the full set is always recoverable from the file
 * manager.
 */
export async function POST(request: NextRequest) {
  try {
    const { fileId } = await request.json();

    if (!fileId) {
      return NextResponse.json(
        { success: false, error: 'File ID is required' },
        { status: 400 }
      );
    }

    const file = await FileStorage.getFile(fileId);
    if (!file) {
      return NextResponse.json(
        { success: false, error: 'File not found' },
        { status: 404 }
      );
    }

    // Rebuild the row grid the same way the table does, so "has an image" means
    // exactly what the button's count means.
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
      return NextResponse.json(
        { success: false, error: 'No question in this file contains an image.' },
        { status: 400 }
      );
    }

    // Re-number the kept rows to 0..n-1. Leaving the original indexes would
    // make the table build a 2,000-row grid with 72 rows filled in. The ID and
    // ID-Q columns still identify every question.
    const cells: CellData[] = [];
    report.questions.forEach((question, newRowIndex) => {
      const sourceRow = rows[question.rowIndex];
      for (const cell of sourceRow) {
        if (!cell) continue;
        cells.push({ ...cell, rowIndex: newRowIndex });
      }
    });

    const filteredId = `${fileId}_images`;
    const filtered: FileData = {
      id: filteredId,
      name: `${file.name} (images only)`,
      uploadDate: new Date().toISOString(),
      totalRows: report.questions.length,
      totalColumns: file.totalColumns,
      cells
    };

    await FileStorage.saveFile(filteredId, filtered);

    console.log(
      `Image filter: kept ${report.stats.withImages} of ${report.stats.totalQuestions} questions ` +
      `(${report.stats.totalImages} images) -> ${filteredId}`
    );

    return NextResponse.json({
      success: true,
      data: filtered,
      stats: report.stats
    });
  } catch (error) {
    console.error('Image filter error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to filter questions'
      },
      { status: 500 }
    );
  }
}
