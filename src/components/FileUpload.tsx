'use client';

import React, { useCallback, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { Upload, FileText, AlertCircle, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface FileUploadProps {
  onFileSelect: (file: File) => void;
  isLoading?: boolean;
  maxSize?: number;
}

export function FileUpload({ 
  onFileSelect, 
  isLoading = false,
  maxSize = 50 * 1024 * 1024 // 50MB
}: FileUploadProps) {
  const [error, setError] = useState<string | null>(null);
  const onDrop = useCallback((acceptedFiles: File[], rejectedFiles: any[]) => {
    setError(null);
    
    if (rejectedFiles.length > 0) {
      const rejection = rejectedFiles[0];
      if (rejection.errors[0]?.code === 'file-too-large') {
        setError(`File is too large. Maximum size is ${Math.round(maxSize / 1024 / 1024)}MB.`);
      } else if (rejection.errors[0]?.code === 'file-invalid-type') {
        setError('Invalid file type. Please upload a spreadsheet (.xlsx, .xls, .csv or .tsv).');
      } else {
        setError('File upload failed. Please try again.');
      }
      return;
    }

    if (acceptedFiles.length > 0) {
      onFileSelect(acceptedFiles[0]);
    }
  }, [onFileSelect, maxSize]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    // Browsers disagree about the MIME type of a .csv - Windows reports it as
    // 'application/vnd.ms-excel', Chrome as 'text/csv', and sometimes it comes
    // through blank. Listing the extension under each plausible type means the
    // file is accepted either way.
    accept: {
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
      'application/vnd.ms-excel': ['.xls', '.csv'],
      'text/csv': ['.csv'],
      'text/tab-separated-values': ['.tsv']
    },
    maxSize,
    multiple: false,
    disabled: isLoading
  });

  return (
    <div className="w-full max-w-2xl mx-auto">
      <div
        {...getRootProps()}
        className={cn(
          "relative border-2 border-dashed rounded-3xl p-10 text-center transition-all duration-300 cursor-pointer bg-white/50 backdrop-blur-sm",
          "hover:border-blue-500 hover:bg-blue-50/30 hover:shadow-md",
          isDragActive && "border-blue-600 bg-blue-50 shadow-lg scale-[1.02]",
          error && "border-red-400 bg-red-50",
          isLoading && "opacity-50 cursor-not-allowed"
        )}
      >
        <input {...getInputProps()} />
        
        <div className="space-y-5">
          <div className="mx-auto w-20 h-20 bg-gradient-to-br from-blue-500 to-purple-600 rounded-2xl flex items-center justify-center shadow-lg">
            {isLoading ? (
              <div className="animate-spin rounded-full h-10 w-10 border-b-3 border-white"></div>
            ) : (
              <Upload className="h-10 w-10 text-white" />
            )}
          </div>
          
          <div>
            <h3 className="text-2xl font-bold text-gray-900 mb-2">
              {isLoading ? 'Processing...' : 'Upload Spreadsheet'}
            </h3>
            <p className="text-gray-600 mb-4 text-lg">
              {isLoading 
                ? 'Please wait while we process your file...'
                : 'Drag and drop your Excel or CSV file here, or click to browse'
              }
            </p>
          </div>

          {!isLoading && (
            <div className="space-y-2 text-sm text-gray-500 font-medium">
              <p>Supported formats: .xlsx, .xls, .csv, .tsv</p>
              <p className="text-gray-400">CSV encoding and delimiter are detected automatically</p>
              <p>Maximum file size: {Math.round(maxSize / 1024 / 1024)}MB</p>
            </div>
          )}

          {error && (
            <div className="flex items-center justify-center gap-2 text-red-600 bg-red-50 rounded-xl p-4 border border-red-200">
              <AlertCircle className="h-5 w-5" />
              <span className="text-sm font-semibold">{error}</span>
            </div>
          )}

          {!isLoading && (
            <Button
              type="button"
              className="bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-white shadow-md hover:shadow-lg transition-all text-base py-3 px-6"
            >
              <FileText className="h-5 w-5 mr-2" />
              Choose File
            </Button>
          )}
        </div>
      </div>

      {isLoading && (
        <div className="mt-5 flex items-center justify-center gap-2 text-blue-600 bg-blue-50 rounded-xl p-4 border border-blue-200">
          <CheckCircle className="h-5 w-5" />
          <span className="text-sm font-semibold">File uploaded successfully!</span>
        </div>
      )}
    </div>
  );
}
