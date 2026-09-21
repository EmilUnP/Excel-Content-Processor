import { NextRequest, NextResponse } from 'next/server';
import { FileStorage } from '@/lib/file-storage';
import { FileData } from '@/types';
import { processExcelFile } from '@/lib/excel-processor';

export async function POST(request: NextRequest) {
  try {
    console.log('=== Upload API ===');
    
    const formData = await request.formData();
    const file = formData.get('file') as File;
    
    console.log('File received:', file?.name, file?.size, file?.type);
    
    if (!file) {
      return NextResponse.json(
        { success: false, error: 'No file provided' },
        { status: 400 }
      );
    }

    // Validate file type by extension.
    //
    // The browser-reported MIME type is not dependable: Windows hands back
    // 'application/vnd.ms-excel' for .csv, some systems send 'text/csv',
    // others send an empty string for a perfectly good .xlsx. The extension is
    // what the user actually chose, and the parser dispatches on it too.
    const allowedExtensions = ['.xlsx', '.xls', '.csv', '.tsv'];
    const fileName = (file.name || '').toLowerCase();
    const isAllowed = allowedExtensions.some((ext) => fileName.endsWith(ext));

    if (!isAllowed) {
      return NextResponse.json(
        {
          success: false,
          error: `Invalid file type. Please upload a spreadsheet (${allowedExtensions.join(', ')}).`
        },
        { status: 400 }
      );
    }

    // Validate file size (50MB limit)
    const maxSize = 50 * 1024 * 1024; // 50MB
    if (file.size > maxSize) {
      return NextResponse.json(
        { success: false, error: 'File too large. Maximum size is 50MB.' },
        { status: 400 }
      );
    }

    console.log('Processing Excel file...');
    
    // Process the Excel file using the proper processor
    const processedData = await processExcelFile(file);
    console.log('Excel processed:', processedData.totalRows, 'rows,', processedData.totalColumns, 'columns');
    
    // Generate unique file ID
    const fileId = `file_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Prepare file data
    const fileData: FileData = {
      id: fileId,
      name: file.name,
      uploadDate: new Date().toISOString(),
      totalRows: processedData.totalRows,
      totalColumns: processedData.totalColumns,
      cells: processedData.cells
    };
    
    console.log('Saving file to storage...');
    // Save to file system
    await FileStorage.saveFile(fileId, fileData);
    console.log('File saved successfully:', fileId);

    return NextResponse.json({
      success: true,
      fileId: fileId,
      data: fileData
    });

  } catch (error) {
    console.error('File upload error:', error);

    const message = error instanceof Error ? error.message : 'Failed to process file';
    // An unreadable or empty upload is a problem with the file, not with the
    // server, so report it as such.
    const isBadInput = /empty|unsupported|corrupt|cannot read|invalid/i.test(message);

    return NextResponse.json(
      { 
        success: false, 
        error: message,
        stack: error instanceof Error ? error.stack : undefined
      },
      { status: isBadInput ? 400 : 500 }
    );
  }
}