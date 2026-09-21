'use client';

import React, { useState, useEffect } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { useEscapeToClose } from '@/hooks/useEscapeToClose';
import { Button } from '@/components/ui/button';
import { 
  X, 
  FileText, 
  Globe, 
  Trash2,
  RefreshCw,
  FolderOpen
} from 'lucide-react';

interface FileItem {
  id: string;
  name: string;
  type: 'original' | 'translated';
  language?: string;
  uploadDate: string;
  totalRows: number;
  totalColumns: number;
  totalCells: number;
  isTranslated?: boolean;
}

export function FileManager() {
  const {
    ui,
    setShowFileManager,
    currentFile,
    setCurrentFile
  } = useAppStore();

  const [fileList, setFileList] = useState<FileItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const loadFiles = async () => {
    console.log('FileManager: Loading files...');
    setIsLoading(true);
    
    try {
      const response = await fetch('/api/files');
      const result = await response.json();
      
      if (result.files) {
        const fileItems: FileItem[] = result.files.map((file: any) => ({
          id: file.id,
          name: file.name,
          type: file.type,
          uploadDate: file.uploadDate,
          totalRows: file.totalRows,
          totalColumns: file.totalColumns,
          totalCells: file.totalCells,
          isTranslated: file.isTranslated,
          language: file.language
        }));
        
        setFileList(fileItems);
        console.log('FileManager: Loaded', fileItems.length, 'files');
      }
    } catch (error) {
      console.error('FileManager: Error loading files:', error);
      setFileList([]);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (ui.showFileManager) {
      loadFiles();
    }
  }, [ui.showFileManager, ui.fileManagerRefreshTrigger]);

  // Escape closes the panel, like any other dialog.
  useEscapeToClose(ui.showFileManager, () => setShowFileManager(false));

  if (!ui.showFileManager) return null;

  const handleLoadFile = async (fileId: string) => {
    try {
      console.log('FileManager: Loading file', fileId);
      const response = await fetch(`/api/files/${fileId}`);
      if (response.ok) {
        const result = await response.json();
        console.log('FileManager: API response:', result);
        
        if (result.success && result.data) {
          setCurrentFile(result.data);
          setShowFileManager(false);
          console.log('FileManager: File loaded successfully, cells:', result.data.cells?.length);
        } else {
          console.error('FileManager: Invalid response format:', result);
        }
      } else {
        console.error('FileManager: API error:', response.status);
      }
    } catch (error) {
      console.error('FileManager: Error loading file:', error);
    }
  };

  const handleDeleteFile = async (fileId: string) => {
    if (confirm('Are you sure you want to delete this file?')) {
      try {
        await fetch(`/api/files/${fileId}`, { method: 'DELETE' });
        await loadFiles();
      } catch (error) {
        console.error('Failed to delete file:', error);
      }
    }
  };

  const getFileIcon = (type: string, language?: string) => {
    if (type === 'translated') {
      return <Globe className="h-5 w-5 text-green-600" />;
    }
    return <FileText className="h-5 w-5 text-blue-600" />;
  };

  const getFileTypeLabel = (type: string, language?: string) => {
    if (type === 'translated') {
      return `Translated (${language})`;
    }
    return 'Original';
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowFileManager(false)} />
        
        <div className="relative w-full max-w-6xl bg-white rounded-3xl shadow-2xl border border-slate-200/50">
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b border-gray-100">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-gradient-to-br from-blue-100 to-blue-50 rounded-xl">
                <FolderOpen className="h-6 w-6 text-blue-600" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-gray-900">
                  File Manager
                </h2>
                <p className="text-sm text-gray-600 mt-0.5">
                  Manage your original and translated files
                </p>
              </div>
            </div>
            <div className="flex items-center space-x-2">
              <Button
                variant="outline"
                size="sm"
                onClick={loadFiles}
                disabled={isLoading}
              >
                <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowFileManager(false)}
                className="h-8 w-8 p-0"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Content */}
          <div className="p-6 max-h-[70vh] overflow-y-auto">
            {isLoading ? (
              <div className="flex items-center justify-center py-16">
                <RefreshCw className="h-8 w-8 animate-spin text-blue-600" />
                <span className="ml-3 text-gray-600 font-medium">Loading files...</span>
              </div>
            ) : fileList.length === 0 ? (
              <div className="text-center py-16">
                <FileText className="h-14 w-14 text-gray-300 mx-auto mb-4" />
                <h3 className="text-lg font-semibold text-gray-900 mb-2">
                  No Files Found
                </h3>
                <p className="text-gray-600 mb-6">
                  Upload a file to get started.
                </p>
                <Button onClick={loadFiles} variant="outline" className="hover:bg-gray-50">
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Refresh Files
                </Button>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {fileList.map((file) => (
                  <div
                    key={file.id}
                    className={`p-5 rounded-xl border cursor-pointer transition-all hover:shadow-lg hover:scale-[1.02] ${
                      currentFile?.id === file.id
                        ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200 shadow-md'
                        : 'border-gray-200 hover:border-blue-300 hover:bg-gray-50'
                    }`}
                    onClick={() => handleLoadFile(file.id)}
                  >
                    <div className="flex items-start justify-between gap-2 mb-3">
                      {/* min-w-0 is required on BOTH flex levels: without it on
                          this one, the row refuses to shrink below its text and
                          long names spill over the neighbouring card. */}
                      <div className="flex items-start gap-3 min-w-0 flex-1">
                        <span className="flex-shrink-0 mt-0.5">
                          {getFileIcon(file.type, file.language)}
                        </span>
                        <div className="min-w-0 flex-1">
                          {/* Wrapped over two lines rather than truncated: the
                              part that tells these files apart - "(images only)",
                              "(images with text)" - sits at the END of the name,
                              which is exactly what truncation would cut. */}
                          <h4
                            className="font-semibold text-gray-900 break-words line-clamp-2 leading-snug"
                            title={file.name}
                          >
                            {file.name}
                          </h4>
                          <p className="text-xs text-gray-500 mt-0.5">
                            {getFileTypeLabel(file.type, file.language)}
                          </p>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteFile(file.id);
                        }}
                        className="h-6 w-6 p-0 text-gray-400 hover:text-red-500 flex-shrink-0 transition-colors"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                    
                    <div className="text-xs text-gray-500 space-y-1.5 bg-gray-50 rounded-lg p-2.5">
                      <div className="flex justify-between font-medium">
                        <span>{file.totalRows.toLocaleString()} rows</span>
                        <span>{file.totalColumns.toLocaleString()} columns</span>
                      </div>
                      <div className="font-medium">{file.totalCells.toLocaleString()} cells</div>
                      <div className="text-gray-400">{new Date(file.uploadDate).toLocaleDateString()}</div>
                    </div>

                    {currentFile?.id === file.id && (
                      <div className="mt-3 flex items-center text-blue-600 font-medium">
                        <div className="w-2 h-2 bg-blue-600 rounded-full mr-2"></div>
                        <span className="text-sm">Currently Active</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between p-6 border-t border-gray-100 bg-gray-50/50 rounded-b-3xl">
            <div className="text-sm text-gray-600 font-medium">
              {fileList.length} file{fileList.length !== 1 ? 's' : ''} found
            </div>
            <div className="flex items-center space-x-2">
              <Button
                variant="outline"
                onClick={() => setShowFileManager(false)}
                className="hover:bg-white"
              >
                Close
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}