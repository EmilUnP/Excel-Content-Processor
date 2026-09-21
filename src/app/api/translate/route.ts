import { NextRequest, NextResponse } from 'next/server';
import { FileStorage } from '@/lib/file-storage';
import { translateDataWithStructure } from '@/lib/translation-service';
import { CellData } from '@/types';

export async function POST(request: NextRequest) {
  try {
    const { fileId, targetLanguage, model = 'gemini-3-flash-preview', cellsToTranslate, cellKeys } = await request.json();

    if (!fileId || !targetLanguage) {
      return NextResponse.json(
        { success: false, error: 'Missing required parameters' },
        { status: 400 }
      );
    }

    // Every model in the picker is served by OpenRouter, so there is exactly
    // one credential to look up.
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        {
          success: false,
          error: 'OPENROUTER_API_KEY is not set. Add it to your .env file - get a key at https://openrouter.ai/keys'
        },
        { status: 500 }
      );
    }

    // Get the file data
    const file = await FileStorage.getFile(fileId);

    if (!file) {
      return NextResponse.json(
        { success: false, error: 'File not found' },
        { status: 404 }
      );
    }

    // Work out which cells to translate.
    // PERFORMANCE: `cellKeys` is the light path - the client sends only the
    // row/column coordinates and the server picks the cells out of the copy it
    // already has on disk. That avoids re-uploading megabytes of cell text on
    // every translation. `cellsToTranslate` (full cells) is still accepted so
    // older clients keep working exactly as before.
    let targetCells: CellData[] | null = null;

    if (Array.isArray(cellKeys) && cellKeys.length > 0) {
      const cellByKey = new Map<string, CellData>();
      for (const cell of file.cells) {
        cellByKey.set(`${cell.rowIndex}:${cell.colIndex}`, cell);
      }
      targetCells = [];
      for (const key of cellKeys as Array<{ rowIndex: number; colIndex: number }>) {
        const cell = cellByKey.get(`${key.rowIndex}:${key.colIndex}`);
        if (cell) targetCells.push(cell);
      }
    } else if (cellsToTranslate && cellsToTranslate.length > 0) {
      targetCells = cellsToTranslate as CellData[];
    }

    // Translate only the filtered cells if provided
    if (targetCells && targetCells.length > 0) {
      // Use the translatable cells directly for translation
      const modifiedFile = {
        ...file,
        cells: targetCells
      };
      
      const cellsToTranslateCount = targetCells.length;
      
      // Log progress in ~10% steps instead of once per batch: on Windows each
      // console write is synchronous and hundreds of them add real wall time.
      let lastLoggedPercent = -1;

      const translatedData = await translateDataWithStructure(
        modifiedFile,
        targetLanguage,
        apiKey,
        model,
        (current, total) => {
          const percent = Math.floor((current / Math.max(cellsToTranslateCount, 1)) * 10) * 10;
          if (percent !== lastLoggedPercent) {
            lastLoggedPercent = percent;
            console.log(`Translation progress: ${current}/${cellsToTranslateCount} cells (${percent}%, filtered from ${file.cells.length} total)`);
          }
        }
      );
      
      // Restore all cells (including untranslatable ones with their original data).
      // PERFORMANCE: index the translated cells once instead of scanning the whole
      // array for every original cell (that was ~13k x ~8k comparisons per run).
      const translatedByKey = new Map<string, CellData>();
      for (const cell of translatedData.cells) {
        translatedByKey.set(`${cell.rowIndex}:${cell.colIndex}`, cell);
      }

      translatedData.cells = file.cells.map(originalCell => {
        const translatedCell = translatedByKey.get(`${originalCell.rowIndex}:${originalCell.colIndex}`);
        if (translatedCell) {
          // Keep the original field from the source file (with HTML/images)
          return {
            ...translatedCell,
            original: originalCell.original
          };
        }
        return originalCell;
      });
      
      // Save the translated data
      await FileStorage.saveFile(`${fileId}_translated_${targetLanguage}`, translatedData);
      
      return NextResponse.json({
        success: true,
        data: {
          fileId: `${fileId}_translated_${targetLanguage}`,
          originalFileId: fileId,
          targetLanguage,
          translatedData
        }
      });
    }
    
    // Fallback to full translation if no cellsToTranslate provided
    const translatedData = await translateDataWithStructure(
      file,
      targetLanguage,
      apiKey,
      model,
      (current, total) => {
        console.log(`Translation progress: ${current}/${total}`);
      }
    );

    // Save the translated data
    await FileStorage.saveFile(`${fileId}_translated_${targetLanguage}`, translatedData);

    return NextResponse.json({
      success: true,
      data: {
        fileId: `${fileId}_translated_${targetLanguage}`,
        originalFileId: fileId,
        targetLanguage,
        translatedData
      }
    });

  } catch (error) {
    console.error('Translation error:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: error instanceof Error ? error.message : 'Translation failed' 
      },
      { status: 500 }
    );
  }
}