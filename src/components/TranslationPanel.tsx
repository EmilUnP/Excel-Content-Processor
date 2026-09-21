'use client';

import React, { useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { useEscapeToClose } from '@/hooks/useEscapeToClose';
import { Button } from '@/components/ui/button';
import { 
  X,
  Globe,
  CheckCircle,
  Square
} from 'lucide-react';

const SUPPORTED_LANGUAGES = [
  { code: 'az', name: 'Azerbaijani', flag: '🇦🇿' },
  { code: 'ru', name: 'Russian', flag: '🇷🇺' },
  { code: 'en', name: 'English', flag: '🇺🇸' },
  { code: 'tr', name: 'Turkish', flag: '🇹🇷' },
];

export function TranslationPanel() {
  const { 
    ui, 
    setShowTranslation,
    currentFile,
    setCurrentFile,
    settings,
    isProcessing,
    setIsProcessing,
    setProcessingProgress,
    triggerFileManagerRefresh
  } = useAppStore();

  // Helper function to check if column is a code column
  const isCodeColumn = (colIndex: number) => {
    return colIndex >= 4 && (colIndex - 4) % 2 === 0;
  };

  const handleClose = () => {
    // Allow closing even when processing - translation continues in background
    setShowTranslation(false);
  };
  
  const handleStopTranslation = () => {
    // Stop translation and reset state
    setIsProcessing(false);
    setProcessingProgress({
      current: 0,
      total: 0,
      percentage: 0,
      message: '',
      status: 'loading',
      estimatedTime: '',
      showSpinner: false
    });
    alert('Translation stopped');
  };

  const [selectedLanguage, setSelectedLanguage] = useState('en');
  const [isTranslating, setIsTranslating] = useState(false);

  // Escape closes the panel, like any other dialog.
  useEscapeToClose(ui.showTranslation, handleClose);

  if (!ui.showTranslation) return null;

  const handleTranslate = async () => {
    if (!currentFile) {
      alert('Please upload a file first');
      return;
    }

    setIsTranslating(true);
    setIsProcessing(true);

    try {
      setProcessingProgress({
        current: 0,
        total: 100,
        percentage: 0,
        message: 'Preparing translation...',
        status: 'loading',
        estimatedTime: '~2 minutes',
        showSpinner: true
      });

      const languageName = SUPPORTED_LANGUAGES.find(lang => lang.code === selectedLanguage)?.name || selectedLanguage;
      const selectedModel = settings.selectedModel || 'gemini-3-flash-preview';
      
      // Filter cells to translate only translatable content
      const translatableCells = currentFile.cells.filter(cell => {
        // Don't translate: ID columns (0, 1), Code columns (4, 6, 8, etc.), null/empty values
        // CRITICAL FIX: Cells with images should STILL be translated - we only skip the image data itself
        // The translation service already handles removing image data before translation and restoring it after
        // Previously we were incorrectly skipping ALL cells with images, now we translate cells that have text content
        const hasContent = cell.cleaned && cell.cleaned.trim() && cell.cleaned.trim() !== 'null' && cell.cleaned.trim() !== 'NULL';
        
        // Check if cell has actual text content (not just pure base64 image data)
        // Even if cell has images, if it has ANY text content, we should translate it
        // The translation service will handle image placeholders correctly
        let hasTextContent = false;
        if (hasContent) {
          // Remove base64 image data patterns to check if there's actual text
          const textWithoutImages = cell.cleaned
            .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=\s]+/g, '')
            .replace(/\[IMAGE_DATA\]/g, '')
            .trim();
          
          // If there's any remaining text after removing image data, translate it
          hasTextContent = textWithoutImages.length > 0 && textWithoutImages.length < 100000;
        }
        
        const shouldTranslate = cell.colIndex !== 0 && // Not ID
               cell.colIndex !== 1 && // Not ID-Q
               !isCodeColumn(cell.colIndex) && // Not code columns
               !cell.isEmpty && // Not empty
               hasTextContent; // Has actual text content to translate (images are handled separately)
        
        // NOTE: a per-cell console.log used to run here. On a real file that is
        // thousands of object serialisations before the request even starts, so
        // the summary log below is used instead.
        return shouldTranslate;
      });
      
      const totalCells = currentFile.cells.length;
      const cellsToTranslate = translatableCells.length;
      
      console.log('Translation Filtering:', {
        totalCells,
        cellsToTranslate,
        skippedCells: totalCells - cellsToTranslate,
        sampleTranslatableCells: translatableCells.slice(0, 3).map(cell => ({
          row: cell.rowIndex,
          col: cell.colIndex,
          hasHtml: cell.hasHtml,
          hasImages: cell.hasImages,
          preview: cell.cleaned?.substring(0, 100)
        }))
      });
      
      // Calculate realistic estimate based on actual cells to translate
      const estimatedMinutes = Math.ceil((cellsToTranslate / 10) * 0.5); // 10 cells per batch, ~30 seconds per batch
      
      // If Gemini is selected on a very large file, show a gentle warning (performance)
      if (settings.selectedModel?.startsWith('gemini-') && cellsToTranslate > 1500) {
        console.warn('Gemini selected for large file; Gemini is usually faster for big datasets.');
      }

      setProcessingProgress({
        current: 10,
        total: 100,
        percentage: 10,
        message: `Translating ${cellsToTranslate} cells to ${languageName} using ${selectedModel}... (${cellsToTranslate} of ${totalCells} selected)`,
        status: 'loading',
        estimatedTime: `~${estimatedMinutes} minute${estimatedMinutes > 1 ? 's' : ''}`,
        showSpinner: true
      });

      console.log('Sending translation request:', {
        fileId: currentFile.id,
        targetLanguage: selectedLanguage,
        model: settings.selectedModel,
        cellsCount: translatableCells.length,
        sampleCell: translatableCells[0] ? {
          row: translatableCells[0].rowIndex,
          col: translatableCells[0].colIndex,
          cleaned: translatableCells[0].cleaned?.substring(0, 100)
        } : null
      });

      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fileId: currentFile.id,
          targetLanguage: selectedLanguage,
          model: settings.selectedModel || 'gemini-3-flash-preview',
          // PERFORMANCE: send coordinates only. The server already has this file
          // on disk, so uploading the full cell text again just cost megabytes of
          // JSON.stringify on the main thread and a slow request body.
          cellKeys: translatableCells.map(cell => ({
            rowIndex: cell.rowIndex,
            colIndex: cell.colIndex
          }))
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error('Translation API error:', errorData);
        throw new Error(errorData.error || 'Translation failed');
      }

      setProcessingProgress({
        current: 70,
        total: 100,
        percentage: 70,
        message: 'Processing translation results...',
        status: 'loading',
        estimatedTime: '~30 seconds',
        showSpinner: true
      });

      const result = await response.json();
      
      console.log('Translation API Response:', {
        success: result.success,
        hasData: !!result.data,
        hasTranslatedData: !!result.data?.translatedData,
        translatedDataCells: result.data?.translatedData?.cells?.length
      });
      
      if (result.data?.translatedData?.cells) {
        // Log some sample translated cells
        const sampleTranslated = result.data.translatedData.cells
          .filter((c: any) => c.colIndex === 2) // Question column
          .slice(0, 3);
        console.log('Sample translated cells:', sampleTranslated.map((c: any) => ({
          row: c.rowIndex,
          col: c.colIndex,
          original: c.original?.substring(0, 100),
          cleaned: c.cleaned?.substring(0, 100)
        })));
      }
      
      if (result.success) {
        setProcessingProgress({
          current: 90,
          total: 100,
          percentage: 90,
          message: 'Finalizing translated content...',
          status: 'loading',
          estimatedTime: '~10 seconds',
          showSpinner: true
        });

        // Update the current file with translated data
        console.log('Setting current file with translated data:', {
          fileId: result.data.translatedData?.id,
          fileName: result.data.translatedData?.name,
          totalCells: result.data.translatedData?.cells?.length,
          sampleCell: result.data.translatedData?.cells?.[0] ? {
            row: result.data.translatedData.cells[0].rowIndex,
            col: result.data.translatedData.cells[0].colIndex,
            original: result.data.translatedData.cells[0].original?.substring(0, 100),
            cleaned: result.data.translatedData.cells[0].cleaned?.substring(0, 100)
          } : null
        });
        setCurrentFile(result.data.translatedData);
        console.log('Current file updated');
        
        setProcessingProgress({
          current: 100,
          total: 100,
          percentage: 100,
          message: `Translation to ${selectedLanguage} completed successfully!`,
          status: 'success',
          estimatedTime: 'Complete',
          showSpinner: false
        });

        // Trigger FileManager refresh
        triggerFileManagerRefresh();

        setTimeout(() => {
          setIsProcessing(false);
          setShowTranslation(false);
        }, 2000);
      } else {
        throw new Error('Translation failed');
      }
    } catch (error) {
      console.error('Translation failed:', error);
      setProcessingProgress({
        current: 0,
        total: 100,
        percentage: 0,
        message: 'Translation failed',
        status: 'error',
        estimatedTime: 'Failed',
        showSpinner: false
      });
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      alert(`Translation failed: ${errorMessage}`);
      setTimeout(() => {
        setIsProcessing(false);
      }, 3000);
    } finally {
      setIsTranslating(false);
    }
  };


  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={handleClose} />
        
        <div className="relative w-full max-w-2xl bg-white rounded-3xl shadow-2xl border border-slate-200/50">
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b border-gray-100">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-gradient-to-br from-blue-100 to-blue-50 rounded-xl">
                <Globe className="h-6 w-6 text-blue-600" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-gray-900">
                  Translate Content
                </h2>
                <p className="text-sm text-gray-600 mt-0.5">
                  Choose target language for AI translation
                </p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleClose}
              className="h-8 w-8 p-0"
              disabled={isTranslating || isProcessing}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* Content */}
          <div className="p-6 space-y-6">


            {/* Language Selection */}
            <div>
              <label className="block text-sm font-bold text-gray-900 mb-3">
                Select Target Language
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-64 overflow-y-auto">
                {SUPPORTED_LANGUAGES.map((language) => (
                  <button
                    key={language.code}
                    onClick={() => setSelectedLanguage(language.code)}
                    className={`flex items-center space-x-3 p-4 rounded-xl border-2 text-left transition-all hover:shadow-md ${
                      selectedLanguage === language.code
                        ? 'border-blue-500 bg-blue-50 text-blue-900 shadow-sm'
                        : 'border-gray-200 hover:border-blue-300 hover:bg-gray-50'
                    }`}
                  >
                    <span className="text-3xl">{language.flag}</span>
                    <div className="flex-1">
                      <div className="font-semibold">{language.name}</div>
                      <div className="text-xs text-gray-500 mt-0.5">{language.code.toUpperCase()}</div>
                    </div>
                    {selectedLanguage === language.code && (
                      <CheckCircle className="h-5 w-5 text-blue-500 flex-shrink-0" />
                    )}
                  </button>
                ))}
              </div>
            </div>

            {/* Translation Info */}

          </div>

          {/* Footer */}
          <div className="flex items-center justify-end space-x-3 p-6 border-t border-gray-100">
            <Button
              variant="outline"
              onClick={handleClose}
              disabled={isTranslating}
              className="hover:bg-gray-50"
            >
              Cancel
            </Button>
            {isTranslating || isProcessing ? (
              <Button
                onClick={handleStopTranslation}
                variant="destructive"
                className="bg-red-500 hover:bg-red-600 shadow-sm hover:shadow-md transition-all"
              >
                <Square className="h-4 w-4 mr-2" />
                Stop Translation
              </Button>
            ) : (
            <Button
              onClick={handleTranslate}
                disabled={isTranslating}
              className="bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 text-white shadow-sm hover:shadow-md transition-all"
            >
                  <Globe className="h-4 w-4 mr-2" />
                  Start Translation
              </Button>
              )}
          </div>
        </div>
      </div>
    </div>
  );
}
