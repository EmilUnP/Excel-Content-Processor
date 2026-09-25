'use client';

import React, { useEffect } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { FileUpload } from '@/components/FileUpload';
import { DataTable } from '@/components/DataTable';
import { TranslationPanel } from '@/components/TranslationPanel';
import { ModelSelectionPanel } from '@/components/ModelSelectionPanel';
import { FileManager } from '@/components/FileManager';
import { ProgressBar } from '@/components/ProgressBar';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { 
  FileText, 
  Globe, 
  Cpu,
  FolderOpen,
  AlertCircle
} from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function HomePage() {
  const {
    currentFile,
    isProcessing,
    processingProgress,
    ui,
    settings,
    setCurrentFile,
    setIsProcessing,
    setProcessingProgress,
    setShowTranslation,
    setShowModelSelection,
    setShowFileManager,
    triggerFileManagerRefresh,
    setError,
  } = useAppStore();

  // Debug current file data
  useEffect(() => {
    if (currentFile) {
      console.log(
        `Main page: ${currentFile.name} - ${currentFile.totalRows} rows x ${currentFile.totalColumns} cols, ${currentFile.cells?.length ?? 0} cells (${currentFile.id})`
      );
    }
  }, [currentFile]);

  // NOTE: two mount-only effects used to live here - one resetting the
  // processing state, one verifying that currentFile still existed on the
  // server. Both were dead: `currentFile` is not persisted, so it is always
  // null on mount, and the processing state already starts idle. The file
  // manager fetches and validates a file at the moment you open it.

  const handleFileSelect = async (file: File) => {
    try {
      setIsProcessing(true);
      setProcessingProgress({
        current: 0,
        total: 100,
        percentage: 0,
        message: 'Preparing file upload...',
        status: 'loading',
        estimatedTime: '~30 seconds',
        showSpinner: true
      });

      const formData = new FormData();
      formData.append('file', file);

      // Simulate upload progress
      setProcessingProgress({
        current: 30,
        total: 100,
        percentage: 30,
        message: 'Uploading file to server...',
        status: 'loading',
        estimatedTime: '~25 seconds',
        showSpinner: true
      });

      const response = await fetch('/api/files/upload', {
        method: 'POST',
        body: formData,
      });

      // Read the body first: the server explains *why* it refused ("Invalid
      // file type...", "File too large...", "The file appears to be empty...").
      // Throwing on response.statusText alone threw that explanation away and
      // showed the user a meaningless "Bad Request".
      const result = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(result?.error || `Upload failed: ${response.statusText}`);
      }
      
      if (result?.success) {
        setProcessingProgress({
          current: 80,
          total: 100,
          percentage: 80,
          message: 'Processing Excel data...',
          status: 'loading',
          estimatedTime: '~10 seconds',
          showSpinner: true
        });

        setCurrentFile(result.data);
        
        setProcessingProgress({
          current: 100,
          total: 100,
          percentage: 100,
          message: 'File uploaded successfully!',
          status: 'success',
          estimatedTime: 'Complete',
          showSpinner: false
        });

        // Hide progress bar after showing success message
        setTimeout(() => {
          setIsProcessing(false);
        }, 2000); // Hide after 2 seconds

        // Trigger FileManager refresh and open it
        triggerFileManagerRefresh();
        setShowFileManager(true);
      } else {
        throw new Error(result.error || 'Upload failed');
      }
    } catch (error) {
      console.error('File upload error:', error);
      setProcessingProgress({
        current: 0,
        total: 100,
        percentage: 0,
        message: 'Upload failed',
        status: 'error',
        estimatedTime: 'Failed',
        showSpinner: false
      });
      setError(error instanceof Error ? error.message : 'Failed to process file');
      setTimeout(() => {
        setIsProcessing(false);
      }, 3000);
    }
  };

  const handleTranslate = () => {
    setShowTranslation(true);
  };

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50/30 to-indigo-50/50">
        {/* Header */}
        <header className="bg-white/70 backdrop-blur-md shadow-sm border-b border-slate-200/50 sticky top-0 z-40">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex flex-col lg:flex-row lg:justify-between lg:items-center py-5 space-y-4 lg:space-y-0">
              <div className="flex items-center">
                <div className="h-11 w-11 bg-gradient-to-br from-blue-600 via-purple-600 to-indigo-600 rounded-xl flex items-center justify-center shadow-md mr-4">
                  <FileText className="h-6 w-6 text-white" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold bg-gradient-to-r from-slate-900 via-slate-800 to-slate-700 bg-clip-text text-transparent">
                    Excel Content Processor v3.4.4
                  </h1>
                  <p className="text-sm text-slate-600 mt-0.5 font-medium">
                    AI-powered data processing and translation
                  </p>
                </div>
              </div>
              
              {currentFile && (
                <div className="flex flex-wrap gap-2.5">
                  <Button
                    onClick={handleTranslate}
                    disabled={isProcessing}
                    className="bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 text-white shadow-sm hover:shadow-md transition-all"
                  >
                    <Globe className="h-4 w-4 mr-2" />
                    {isProcessing ? 'Translating...' : 'Translate'}
                  </Button>
                  
                  
                  <Button
                    onClick={() => setShowFileManager(true)}
                    variant="outline"
                    className="border-slate-300 hover:bg-slate-50 hover:border-slate-400 transition-all"
                  >
                    <FolderOpen className="h-4 w-4 mr-2" />
                    Files
                  </Button>
                  
                  <Button
                    onClick={() => setShowModelSelection(true)}
                    variant="outline"
                    className="border-slate-300 hover:bg-slate-50 hover:border-slate-400 transition-all max-w-[240px]"
                    title={settings.selectedModel}
                  >
                    <Cpu className="h-4 w-4 mr-2 flex-shrink-0" />
                    <span className="truncate">{settings.selectedModel}</span>
                  </Button>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Top progress toast — only when the translation dialog is closed.
            While Translate is open, that dialog is the single progress UI
            (avoids two identical bars on one page). */}
        {isProcessing && !ui.showTranslation && (
          <ProgressBar
            current={processingProgress.current}
            total={processingProgress.total}
            percentage={processingProgress.percentage}
            message={processingProgress.message}
            status={processingProgress.status}
            estimatedTime={processingProgress.estimatedTime}
            showSpinner={processingProgress.showSpinner}
          />
        )}

        {/* Error Display */}
        {ui.error && (
          <div className="bg-red-50/80 backdrop-blur-sm border-l-4 border-red-500 p-4 mx-4 sm:mx-6 lg:mx-8 rounded-r-lg shadow-sm">
            <div className="flex">
              <AlertCircle className="h-5 w-5 text-red-500 flex-shrink-0" />
              <div className="ml-3">
                <p className="text-sm font-medium text-red-800">{ui.error}</p>
                <button
                  onClick={() => setError(null)}
                  className="mt-2 text-xs text-red-600 hover:text-red-800 font-medium underline transition-colors"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Main Content */}
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          {!currentFile ? (
            <div className="text-center">
              <div className="bg-white/90 backdrop-blur-sm rounded-3xl shadow-xl border border-slate-100 p-8 sm:p-12 max-w-4xl mx-auto">
                <div className="mb-10">
                  <div className="inline-flex items-center justify-center w-20 h-20 bg-gradient-to-r from-blue-500 to-purple-600 rounded-2xl mb-6 shadow-lg">
                    <FileText className="h-10 w-10 text-white" />
                  </div>
                  <h2 className="text-4xl font-bold text-gray-900 mb-4">
                    Excel Content Processor v3.4.4
                  </h2>
                  <p className="text-xl text-gray-600 mb-8 max-w-3xl mx-auto leading-relaxed">
                    Transform your complex HTML-encoded Excel data into clean, readable content. 
                    Upload, clean, translate, and export with AI-powered processing.
                  </p>
                </div>
                
                {/* File Manager or Upload */}
                <div className="space-y-6">
                  <div className="flex flex-col sm:flex-row gap-4 justify-center">
                    <Button
                      onClick={() => setShowFileManager(true)}
                      className="bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 text-white px-8 py-3 text-lg shadow-md hover:shadow-lg transition-all"
                    >
                      <FolderOpen className="h-5 w-5 mr-2" />
                      Open Existing Files
                    </Button>
                  
                  </div>
                  
                  <div className="text-sm text-gray-500 font-medium">
                    Or drag and drop your Excel / CSV file below
                  </div>
                  
                  <FileUpload 
                    onFileSelect={handleFileSelect}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              {/* File Info */}
              <div className="bg-white/90 backdrop-blur-sm rounded-2xl shadow-md border border-slate-200/50 p-5 sm:p-6">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                  <div>
                    <h2 className="text-xl font-bold text-slate-800 flex items-center">
                      <FileText className="h-5 w-5 mr-2 text-blue-600" />
                      {currentFile.name}
                    </h2>
                    <p className="text-slate-600 mt-1 font-medium">
                      {currentFile.totalRows.toLocaleString()} rows • {currentFile.totalColumns.toLocaleString()} columns • {(currentFile.cells?.length || 0).toLocaleString()} cells
                    </p>
                  </div>
                  <div className="flex items-center space-x-2">
                    {isProcessing ? (
                      <>
                        <div className="w-3 h-3 bg-blue-500 rounded-full animate-pulse" />
                        <span className="text-blue-600 text-sm font-semibold">
                          Working… {processingProgress.percentage}%
                        </span>
                      </>
                    ) : (
                      <>
                        <div className="w-3 h-3 bg-gradient-to-r from-green-400 to-emerald-400 rounded-full animate-pulse" />
                        <span className="text-green-600 text-sm font-semibold">Ready</span>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Data Table */}
              <div className="bg-white/90 backdrop-blur-sm rounded-2xl shadow-md border border-slate-200/50 overflow-hidden">
                <DataTable
                  data={currentFile.cells}
                  fileId={currentFile.id}
                  fileName={currentFile.name}
                  selectedModel={settings.selectedModel}
                  editable={true}
                  showMetadata={true}
                  onFileReplaced={(file) => {
                    // An action rewrote the open file into a new stored file.
                    setCurrentFile(file);
                    triggerFileManagerRefresh();
                  }}
                />
              </div>
            </div>
          )}
        </main>

        {/* Modals */}
        <TranslationPanel />
        <ModelSelectionPanel />
        <FileManager />
      </div>
    </ErrorBoundary>
  );
}
