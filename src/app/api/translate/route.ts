import { NextRequest, NextResponse } from 'next/server';
import { FileStorage } from '@/lib/file-storage';
import { translateDataWithStructure } from '@/lib/translation-service';
import { findRussianLeftovers } from '@/lib/russian-leftover-check';
import { CellData } from '@/types';

// Long files (thousands of cells) can run for a long time on self-hosted /
// local Node. Harmless on next dev; needed if ever deployed behind a platform
// that caps route duration.
export const maxDuration = 3600;
export const dynamic = 'force-dynamic';

type StreamEvent =
  | { type: 'started'; total: number; message: string }
  | { type: 'progress'; current: number; total: number; percentage: number }
  | { type: 'finalizing'; message: string }
  | {
      type: 'complete';
      success: true;
      data: {
        fileId: string;
        originalFileId: string;
        targetLanguage: string;
        translatedData: unknown;
        russianCheck: {
          ok: boolean;
          hitCount: number;
          hits: Array<{
            rowIndex: number;
            colIndex: number;
            idQ: string;
            preview: string;
            cyrillicCount: number;
          }>;
          scannedCells: number;
        };
      };
    }
  | { type: 'error'; success: false; error: string };

export async function POST(request: NextRequest) {
  let body: {
    fileId?: string;
    targetLanguage?: string;
    model?: string;
    cellsToTranslate?: CellData[];
    cellKeys?: Array<{ rowIndex: number; colIndex: number }>;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid JSON body' },
      { status: 400 }
    );
  }

  const {
    fileId,
    targetLanguage,
    model = 'gemini-3-flash-preview',
    cellsToTranslate,
    cellKeys
  } = body;

  if (!fileId || !targetLanguage) {
    return NextResponse.json(
      { success: false, error: 'Missing required parameters' },
      { status: 400 }
    );
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        success: false,
        error:
          'OPENROUTER_API_KEY is not set. Add it to your .env file - get a key at https://openrouter.ai/keys'
      },
      { status: 500 }
    );
  }

  const file = await FileStorage.getFile(fileId);
  if (!file) {
    return NextResponse.json(
      { success: false, error: 'File not found' },
      { status: 404 }
    );
  }

  let targetCells: CellData[] | null = null;

  if (Array.isArray(cellKeys) && cellKeys.length > 0) {
    const cellByKey = new Map<string, CellData>();
    for (const cell of file.cells) {
      cellByKey.set(`${cell.rowIndex}:${cell.colIndex}`, cell);
    }
    targetCells = [];
    for (const key of cellKeys) {
      const cell = cellByKey.get(`${key.rowIndex}:${key.colIndex}`);
      if (cell) targetCells.push(cell);
    }
  } else if (cellsToTranslate && cellsToTranslate.length > 0) {
    targetCells = cellsToTranslate;
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: StreamEvent) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      try {
        const workFile =
          targetCells && targetCells.length > 0
            ? { ...file, cells: targetCells }
            : file;

        const cellsToTranslateCount = workFile.cells.length;
        let lastLoggedPercent = -1;
        let lastSentCurrent = -1;

        send({
          type: 'started',
          total: cellsToTranslateCount,
          message: `Translating ${cellsToTranslateCount} cells to ${targetLanguage}`
        });

        const translatedData = await translateDataWithStructure(
          workFile,
          targetLanguage,
          apiKey,
          model,
          (current, total) => {
            const percentage = Math.min(
              99,
              Math.floor((current / Math.max(total, 1)) * 100)
            );

            // Console: ~10% steps (Windows sync writes are expensive).
            const bucket = Math.floor(percentage / 10) * 10;
            if (bucket !== lastLoggedPercent) {
              lastLoggedPercent = bucket;
              console.log(
                `Translation progress: ${current}/${cellsToTranslateCount} cells (${bucket}%, filtered from ${file.cells.length} total)`
              );
            }

            // UI: every completed batch (monotonic).
            if (current !== lastSentCurrent) {
              lastSentCurrent = current;
              send({ type: 'progress', current, total, percentage });
            }
          }
        );

        send({
          type: 'finalizing',
          message: 'Saving translated file…'
        });

        // When only a subset was translated, restore untouched cells.
        if (targetCells && targetCells.length > 0) {
          const translatedByKey = new Map<string, CellData>();
          for (const cell of translatedData.cells) {
            translatedByKey.set(`${cell.rowIndex}:${cell.colIndex}`, cell);
          }

          translatedData.cells = file.cells.map((originalCell) => {
            const translatedCell = translatedByKey.get(
              `${originalCell.rowIndex}:${originalCell.colIndex}`
            );
            if (translatedCell) {
              return {
                ...translatedCell,
                original: originalCell.original
              };
            }
            return originalCell;
          });
        }

        const outId = `${fileId}_translated_${targetLanguage}`;
        await FileStorage.saveFile(outId, translatedData);

        // Simple finish check: any Russian alphabet left = translation problem.
        const russianCheck = findRussianLeftovers(
          translatedData.cells,
          targetLanguage
        );
        if (russianCheck.ok) {
          console.log(
            `Russian leftover check: OK (${russianCheck.scannedCells} cells scanned)`
          );
        } else {
          console.warn(
            `Russian leftover check: PROBLEM — ${russianCheck.hitCount} cell(s) still have Cyrillic`
          );
          for (const hit of russianCheck.hits.slice(0, 10)) {
            console.warn(
              `  ${hit.idQ} row ${hit.rowIndex + 1} col ${hit.colIndex}: ${hit.preview}`
            );
          }
        }

        send({
          type: 'complete',
          success: true,
          data: {
            fileId: outId,
            originalFileId: fileId,
            targetLanguage,
            translatedData,
            russianCheck
          }
        });
      } catch (error) {
        console.error('Translation error:', error);
        send({
          type: 'error',
          success: false,
          error: error instanceof Error ? error.message : 'Translation failed'
        });
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      // Hint reverse proxies not to buffer the whole response.
      'X-Accel-Buffering': 'no'
    }
  });
}
