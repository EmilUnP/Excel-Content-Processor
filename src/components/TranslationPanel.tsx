'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { useEscapeToClose } from '@/hooks/useEscapeToClose';
import { Button } from '@/components/ui/button';
import {
  X,
  Globe,
  CheckCircle,
  Square,
  Loader2,
  Minimize2,
  AlertCircle
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { FileData } from '@/types';

const SUPPORTED_LANGUAGES = [
  { code: 'az', name: 'Azerbaijani', flag: '🇦🇿' },
  { code: 'ru', name: 'Russian', flag: '🇷🇺' },
  { code: 'en', name: 'English', flag: '🇺🇸' },
  { code: 'tr', name: 'Turkish', flag: '🇹🇷' },
];

type Phase = 'select' | 'running' | 'done' | 'error';

type RussianCheckSummary = {
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

type TranslateStreamEvent =
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
        translatedData: FileData;
        russianCheck?: RussianCheckSummary;
      };
    }
  | { type: 'error'; success: false; error: string };

const formatElapsed = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m <= 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
};

/** ETA from actual throughput once enough cells have finished. */
const formatEta = (done: number, total: number, elapsedSec: number): string => {
  if (done < 20 || elapsedSec < 3) return 'Calculating…';
  const remainingCells = Math.max(total - done, 0);
  if (remainingCells === 0) return 'Almost done';
  const cellsPerSec = done / elapsedSec;
  if (cellsPerSec <= 0) return 'Calculating…';
  const remainingSec = Math.ceil(remainingCells / cellsPerSec);
  return `~${formatElapsed(remainingSec)} left`;
};

export function TranslationPanel() {
  const {
    ui,
    setShowTranslation,
    currentFile,
    setCurrentFile,
    settings,
    isProcessing,
    setIsProcessing,
    processingProgress,
    setProcessingProgress,
    triggerFileManagerRefresh
  } = useAppStore();

  const isCodeColumn = (colIndex: number) => {
    return colIndex >= 4 && (colIndex - 4) % 2 === 0;
  };

  const [selectedLanguage, setSelectedLanguage] = useState('en');
  const [phase, setPhase] = useState<Phase>('select');
  const [errorMessage, setErrorMessage] = useState('');
  const [cellsToTranslate, setCellsToTranslate] = useState(0);
  const [cellsDone, setCellsDone] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [etaLabel, setEtaLabel] = useState('Calculating…');

  const [russianCheck, setRussianCheck] = useState<RussianCheckSummary | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number>(0);
  const progressRef = useRef({ current: 0, total: 0 });

  const clearElapsedTimer = () => {
    if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
  };

  const resetIdleProgress = () => {
    setProcessingProgress({
      current: 0,
      total: 0,
      percentage: 0,
      message: '',
      status: 'loading',
      estimatedTime: '',
      showSpinner: false
    });
  };

  const handleClose = () => {
    if (phase === 'running') {
      setShowTranslation(false);
      return;
    }
    setShowTranslation(false);
    if (phase === 'done' || phase === 'error') {
      setPhase('select');
      setErrorMessage('');
    }
  };

  const handleStopTranslation = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    clearElapsedTimer();
    setIsProcessing(false);
    setPhase('select');
    resetIdleProgress();
    setElapsedSec(0);
    setCellsDone(0);
    setEtaLabel('Calculating…');
  };

  useEscapeToClose(ui.showTranslation, handleClose, phase !== 'running');

  useEffect(() => {
    if (!isProcessing && phase === 'running' && !ui.showTranslation) {
      setPhase('select');
      clearElapsedTimer();
    }
  }, [isProcessing, phase, ui.showTranslation]);

  useEffect(() => {
    return () => {
      clearElapsedTimer();
    };
  }, []);

  if (!ui.showTranslation) return null;

  const languageName =
    SUPPORTED_LANGUAGES.find((lang) => lang.code === selectedLanguage)?.name ||
    selectedLanguage;
  const selectedModel = settings.selectedModel || 'gemini-3-flash-preview';

  const applyServerProgress = (
    current: number,
    total: number,
    percentage: number,
    languageLabel: string,
    model: string
  ) => {
    progressRef.current = { current, total };
    setCellsDone(current);
    setCellsToTranslate(total);

    const elapsed = Math.max(
      1,
      Math.floor((Date.now() - startedAtRef.current) / 1000)
    );
    const eta = formatEta(current, total, elapsed);
    setEtaLabel(eta);

    setProcessingProgress({
      current,
      total,
      percentage,
      message: `Translating ${total.toLocaleString()} cells to ${languageLabel} with ${model}`,
      status: 'loading',
      estimatedTime: `${eta} · elapsed ${formatElapsed(elapsed)}`,
      showSpinner: true
    });
  };

  const startElapsedClock = (languageLabel: string, model: string, total: number) => {
    clearElapsedTimer();
    startedAtRef.current = Date.now();
    setElapsedSec(0);
    progressRef.current = { current: 0, total };

    elapsedTimerRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000);
      setElapsedSec(elapsed);
      const { current, total: tot } = progressRef.current;
      const eta = formatEta(current, tot, elapsed);
      setEtaLabel(eta);

      // Refresh only the time labels — cell counts come from the server stream.
      setProcessingProgress({
        current,
        total: tot,
        percentage:
          tot > 0 ? Math.min(99, Math.floor((current / tot) * 100)) : 0,
        message: `Translating ${tot.toLocaleString()} cells to ${languageLabel} with ${model}`,
        status: 'loading',
        estimatedTime: `${eta} · elapsed ${formatElapsed(elapsed)}`,
        showSpinner: true
      });
    }, 1000);
  };

  const readTranslateStream = async (
    response: Response,
    languageLabel: string,
    model: string,
    fallbackTotal: number
  ): Promise<{ translatedData: FileData; russianCheck?: RussianCheckSummary }> => {
    if (!response.body) {
      throw new Error('No response body from translation server');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let translatedData: FileData | null = null;
    let russianCheckResult: RussianCheckSummary | undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let event: TranslateStreamEvent;
        try {
          event = JSON.parse(trimmed) as TranslateStreamEvent;
        } catch {
          console.warn('Skipping malformed progress line');
          continue;
        }

        if (event.type === 'started') {
          progressRef.current.total = event.total;
          setCellsToTranslate(event.total);
          setProcessingProgress({
            current: 0,
            total: event.total,
            percentage: 0,
            message: event.message,
            status: 'loading',
            estimatedTime: 'Calculating…',
            showSpinner: true
          });
        } else if (event.type === 'progress') {
          applyServerProgress(
            event.current,
            event.total,
            event.percentage,
            languageLabel,
            model
          );
        } else if (event.type === 'finalizing') {
          const tot = progressRef.current.total || fallbackTotal;
          setProcessingProgress({
            current: tot,
            total: tot,
            percentage: 99,
            message: event.message,
            status: 'loading',
            estimatedTime: 'Almost done',
            showSpinner: true
          });
        } else if (event.type === 'complete') {
          translatedData = event.data.translatedData;
          russianCheckResult = event.data.russianCheck;
        } else if (event.type === 'error') {
          throw new Error(event.error || 'Translation failed');
        }
      }
    }

    if (!translatedData) {
      throw new Error('Translation finished without a result');
    }
    return { translatedData, russianCheck: russianCheckResult };
  };

  const handleTranslate = async () => {
    if (!currentFile) {
      alert('Please upload a file first');
      return;
    }

    const languageLabel =
      SUPPORTED_LANGUAGES.find((lang) => lang.code === selectedLanguage)?.name ||
      selectedLanguage;
    const model = settings.selectedModel || 'gemini-3-flash-preview';

    const translatableCells = currentFile.cells.filter((cell) => {
      const hasContent =
        cell.cleaned &&
        cell.cleaned.trim() &&
        cell.cleaned.trim() !== 'null' &&
        cell.cleaned.trim() !== 'NULL';

      let hasTextContent = false;
      if (hasContent) {
        const textWithoutImages = cell.cleaned
          .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=\s]+/g, '')
          .replace(/\[IMAGE_DATA\]/g, '')
          .trim();
        hasTextContent =
          textWithoutImages.length > 0 && textWithoutImages.length < 100000;
      }

      return (
        cell.colIndex !== 0 &&
        cell.colIndex !== 1 &&
        !isCodeColumn(cell.colIndex) &&
        !cell.isEmpty &&
        hasTextContent
      );
    });

    const cellCount = translatableCells.length;

    setCellsToTranslate(cellCount);
    setCellsDone(0);
    setEtaLabel('Calculating…');
    setPhase('running');
    setErrorMessage('');
    setIsProcessing(true);

    setProcessingProgress({
      current: 0,
      total: cellCount,
      percentage: 0,
      message: `Preparing ${cellCount.toLocaleString()} cells for ${languageLabel}…`,
      status: 'loading',
      estimatedTime: 'Calculating…',
      showSpinner: true
    });

    startElapsedClock(languageLabel, model, cellCount);

    const controller = new AbortController();
    abortRef.current = controller;

    console.log('Translation Filtering:', {
      totalCells: currentFile.cells.length,
      cellsToTranslate: cellCount,
      skippedCells: currentFile.cells.length - cellCount
    });

    try {
      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/x-ndjson'
        },
        signal: controller.signal,
        body: JSON.stringify({
          fileId: currentFile.id,
          targetLanguage: selectedLanguage,
          model,
          cellKeys: translatableCells.map((cell) => ({
            rowIndex: cell.rowIndex,
            colIndex: cell.colIndex
          }))
        })
      });

      // Pre-stream HTTP errors still come back as JSON.
      const contentType = response.headers.get('content-type') || '';
      if (!response.ok) {
        const errorData = contentType.includes('json')
          ? await response.json().catch(() => null)
          : null;
        throw new Error(errorData?.error || `Translation failed (${response.status})`);
      }

      const { translatedData, russianCheck: check } = await readTranslateStream(
        response,
        languageLabel,
        model,
        cellCount
      );

      clearElapsedTimer();
      setCurrentFile(translatedData);
      triggerFileManagerRefresh();
      setRussianCheck(check ?? null);

      const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000);
      setElapsedSec(elapsed);
      setCellsDone(cellCount);
      setPhase('done');

      const leftoverMsg =
        check && !check.ok
          ? ` · WARNING: ${check.hitCount} cell(s) still have Russian letters`
          : check?.ok
            ? ' · No Russian leftovers'
            : '';

      setProcessingProgress({
        current: cellCount,
        total: cellCount,
        percentage: 100,
        message: `Translated ${cellCount.toLocaleString()} cells to ${languageLabel}${leftoverMsg}`,
        status: check && !check.ok ? 'error' : 'success',
        estimatedTime: `Done in ${formatElapsed(elapsed)}`,
        showSpinner: false
      });

      setTimeout(() => {
        setIsProcessing(false);
        setShowTranslation(false);
        setPhase('select');
        setRussianCheck(null);
      }, check && !check.ok ? 8000 : 2200);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }
      console.error('Translation failed:', error);
      clearElapsedTimer();
      const msg = error instanceof Error ? error.message : 'Unknown error occurred';
      setErrorMessage(msg);
      setPhase('error');
      setProcessingProgress({
        current: cellsDone,
        total: cellCount,
        percentage: 0,
        message: 'Translation failed',
        status: 'error',
        estimatedTime: 'Failed',
        showSpinner: false
      });
      setTimeout(() => {
        setIsProcessing(false);
      }, 3000);
    } finally {
      abortRef.current = null;
    }
  };

  const livePct = processingProgress.percentage;
  const isRunning = phase === 'running';

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex min-h-screen items-center justify-center p-4">
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm"
          onClick={isRunning ? undefined : handleClose}
        />

        <div
          role="dialog"
          aria-modal="true"
          aria-label={isRunning ? 'Translation in progress' : 'Translate Content'}
          className="relative w-full max-w-2xl bg-white rounded-3xl shadow-2xl border border-slate-200/50"
        >
          <div className="flex items-center justify-between p-6 border-b border-gray-100">
            <div className="flex items-center space-x-3">
              <div
                className={cn(
                  'p-2 rounded-xl',
                  phase === 'done'
                    ? 'bg-emerald-50'
                    : phase === 'error'
                      ? 'bg-red-50'
                      : 'bg-gradient-to-br from-blue-100 to-blue-50'
                )}
              >
                {phase === 'running' ? (
                  <Loader2 className="h-6 w-6 text-blue-600 animate-spin" />
                ) : phase === 'done' ? (
                  <CheckCircle className="h-6 w-6 text-emerald-600" />
                ) : phase === 'error' ? (
                  <AlertCircle className="h-6 w-6 text-red-600" />
                ) : (
                  <Globe className="h-6 w-6 text-blue-600" />
                )}
              </div>
              <div>
                <h2 className="text-xl font-bold text-gray-900">
                  {phase === 'running'
                    ? 'Translating…'
                    : phase === 'done'
                      ? russianCheck && !russianCheck.ok
                        ? 'Translation finished — Russian leftovers found'
                        : 'Translation complete'
                      : phase === 'error'
                        ? 'Translation failed'
                        : 'Translate Content'}
                </h2>
                <p className="text-sm text-gray-600 mt-0.5">
                  {phase === 'select'
                    ? 'Choose target language for AI translation'
                    : phase === 'running'
                      ? 'Live progress from the server'
                      : phase === 'done'
                        ? russianCheck && !russianCheck.ok
                          ? `${russianCheck.hitCount} cell(s) still contain Russian letters — re-translate those rows`
                          : russianCheck?.ok
                            ? 'No Russian alphabet left — looks clean'
                            : 'Your table has been updated'
                        : 'Something went wrong'}
                </p>
              </div>
            </div>
            {isRunning ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClose}
                className="h-8 gap-1.5 px-2 text-gray-600"
                title="Hide this dialog — progress stays at the top"
              >
                <Minimize2 className="h-4 w-4" />
                <span className="text-xs font-medium">Hide</span>
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClose}
                className="h-8 w-8 p-0"
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>

          <div className="p-6 space-y-6">
            {phase === 'select' && (
              <div>
                <label className="block text-sm font-bold text-gray-900 mb-3">
                  Select Target Language
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-64 overflow-y-auto">
                  {SUPPORTED_LANGUAGES.map((language) => (
                    <button
                      key={language.code}
                      type="button"
                      onClick={() => setSelectedLanguage(language.code)}
                      className={cn(
                        'flex items-center space-x-3 p-4 rounded-xl border-2 text-left transition-all hover:shadow-md',
                        selectedLanguage === language.code
                          ? 'border-blue-500 bg-blue-50 text-blue-900 shadow-sm'
                          : 'border-gray-200 hover:border-blue-300 hover:bg-gray-50'
                      )}
                    >
                      <span className="text-3xl">{language.flag}</span>
                      <div className="flex-1">
                        <div className="font-semibold">{language.name}</div>
                        <div className="text-xs text-gray-500 mt-0.5">
                          {language.code.toUpperCase()}
                        </div>
                      </div>
                      {selectedLanguage === language.code && (
                        <CheckCircle className="h-5 w-5 text-blue-500 flex-shrink-0" />
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {(phase === 'running' || phase === 'done') && (
              <div className="space-y-4">
                <div className="rounded-2xl bg-slate-50 border border-slate-100 p-4 space-y-3">
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <div className="text-xs text-gray-500 font-medium">Language</div>
                      <div className="font-semibold text-gray-900">{languageName}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 font-medium">Model</div>
                      <div className="font-semibold text-gray-900 truncate">{selectedModel}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 font-medium">Progress</div>
                      <div className="font-semibold text-gray-900 tabular-nums">
                        {cellsDone.toLocaleString()} / {cellsToTranslate.toLocaleString()} cells
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 font-medium">
                        {phase === 'done' ? 'Total time' : 'Time'}
                      </div>
                      <div className="font-semibold text-gray-900 tabular-nums">
                        {formatElapsed(elapsedSec)}
                        {phase === 'running' && (
                          <span className="text-gray-400 font-normal"> · {etaLabel}</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-1.5 pt-1">
                    <div className="h-2.5 w-full rounded-full bg-gray-200 overflow-hidden">
                      <div
                        className={cn(
                          'h-full rounded-full transition-all duration-300 ease-out',
                          phase === 'done'
                            ? russianCheck && !russianCheck.ok
                              ? 'bg-gradient-to-r from-amber-500 to-orange-500'
                              : 'bg-gradient-to-r from-emerald-500 to-teal-500'
                            : 'bg-gradient-to-r from-blue-500 via-cyan-500 to-indigo-500'
                        )}
                        style={{ width: `${Math.min(livePct, 100)}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-xs text-gray-500 tabular-nums">
                      <span>
                        {phase === 'running'
                          ? 'Synced with server batches'
                          : 'Finished'}
                      </span>
                      <span className="font-semibold text-gray-700">{livePct}%</span>
                    </div>
                  </div>
                </div>

                {phase === 'done' && russianCheck && (
                  <div
                    className={cn(
                      'rounded-xl border p-4 text-sm',
                      russianCheck.ok
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                        : 'border-amber-300 bg-amber-50 text-amber-950'
                    )}
                  >
                    {russianCheck.ok ? (
                      <p className="font-medium">
                        Russian alphabet check: clean — no Cyrillic letters found
                        in {russianCheck.scannedCells.toLocaleString()} cells.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        <p className="font-medium">
                          Russian alphabet check: problem — {russianCheck.hitCount}{' '}
                          cell(s) still contain Russian letters.
                        </p>
                        <ul className="max-h-40 overflow-y-auto space-y-1 text-xs font-mono">
                          {russianCheck.hits.slice(0, 15).map((hit) => (
                            <li key={`${hit.rowIndex}:${hit.colIndex}`}>
                              {hit.idQ} (row {hit.rowIndex + 1}, col {hit.colIndex}):{' '}
                              {hit.preview}
                            </li>
                          ))}
                        </ul>
                        {russianCheck.hitCount > 15 && (
                          <p className="text-xs">
                            …and {russianCheck.hitCount - 15} more. Run{' '}
                            <code className="bg-amber-100 px-1 rounded">npm run check:russian</code>{' '}
                            for the full list.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {phase === 'running' && (
                  <p className="text-sm text-gray-600 leading-relaxed">
                    Numbers update as each batch finishes on the server. You can{' '}
                    <button
                      type="button"
                      onClick={handleClose}
                      className="text-blue-600 font-medium underline underline-offset-2 hover:text-blue-700"
                    >
                      hide this dialog
                    </button>{' '}
                    — progress stays at the top of the page.
                  </p>
                )}
              </div>
            )}

            {phase === 'error' && (
              <div className="rounded-2xl bg-red-50 border border-red-100 p-4 text-sm text-red-800">
                {errorMessage || 'Translation failed. Try again or pick another model.'}
              </div>
            )}
          </div>

          <div className="flex items-center justify-end space-x-3 p-6 border-t border-gray-100">
            {phase === 'select' && (
              <>
                <Button
                  variant="outline"
                  onClick={handleClose}
                  className="hover:bg-gray-50"
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleTranslate}
                  className="bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 text-white shadow-sm hover:shadow-md transition-all"
                >
                  <Globe className="h-4 w-4 mr-2" />
                  Start Translation
                </Button>
              </>
            )}

            {phase === 'running' && (
              <>
                <Button
                  variant="outline"
                  onClick={handleClose}
                  className="hover:bg-gray-50"
                >
                  <Minimize2 className="h-4 w-4 mr-2" />
                  Hide & keep working
                </Button>
                <Button
                  onClick={handleStopTranslation}
                  variant="destructive"
                  className="bg-red-500 hover:bg-red-600 shadow-sm hover:shadow-md transition-all"
                >
                  <Square className="h-4 w-4 mr-2" />
                  Stop
                </Button>
              </>
            )}

            {(phase === 'done' || phase === 'error') && (
              <Button onClick={handleClose}>Close</Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
