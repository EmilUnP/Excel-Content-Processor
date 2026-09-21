'use client';

import React, { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { useEscapeToClose } from '@/hooks/useEscapeToClose';
import { X, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ActionDialogState = 'confirm' | 'running' | 'done' | 'error';

export interface ActionProgress {
  done: number;
  total: number;
  /** What is happening right now, e.g. "Reading image 12 of 128". */
  label?: string;
}

interface ActionDialogProps {
  open: boolean;
  title: string;
  state: ActionDialogState;
  /** The plan before running, the outcome after. */
  children: ReactNode;
  progress?: ActionProgress;
  confirmLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
}

const STATE_ICON: Record<ActionDialogState, ReactNode> = {
  confirm: <AlertTriangle className="h-5 w-5 text-amber-600" />,
  running: <Loader2 className="h-5 w-5 text-blue-600 animate-spin" />,
  done: <CheckCircle2 className="h-5 w-5 text-green-600" />,
  error: <AlertTriangle className="h-5 w-5 text-red-600" />
};

/**
 * Confirm / progress / result dialog for the table actions.
 *
 * Replaces the native `confirm()` and `alert()` these actions used to call.
 * Those render as the browser's own chrome, cannot show progress, and block the
 * page - which made a two-minute image analysis look like the app had frozen.
 */
export function ActionDialog({
  open,
  title,
  state,
  children,
  progress,
  confirmLabel = 'Run',
  onConfirm,
  onClose
}: ActionDialogProps) {
  const dismissable = state !== 'running';
  useEscapeToClose(open, onClose, dismissable);

  if (!open || typeof document === 'undefined') return null;

  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.done / progress.total) * 100))
      : 0;

  // Rendered at the document root so the table's overflow and stacking contexts
  // cannot clip or trap it.
  return createPortal(
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex min-h-screen items-center justify-center p-4">
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm"
          onClick={dismissable ? onClose : undefined}
        />

        <div
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className="relative w-full max-w-lg bg-white rounded-3xl shadow-2xl border border-slate-200/50"
        >
          <div className="flex items-center justify-between p-5 border-b border-gray-100">
            <div className="flex items-center gap-2.5">
              {STATE_ICON[state]}
              <h2 className="text-lg font-bold text-gray-900">{title}</h2>
            </div>
            {dismissable && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onClose}
                className="h-8 w-8 p-0"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>

          <div className="p-5 text-sm text-gray-700 space-y-3 max-h-[60vh] overflow-y-auto">
            {children}

            {state === 'running' && progress && (
              <div className="pt-1 space-y-1.5">
                <div className="h-2 w-full rounded-full bg-gray-100 overflow-hidden">
                  <div
                    className={cn(
                      'h-full rounded-full bg-gradient-to-r from-blue-500 to-indigo-500 transition-all duration-300',
                      // Before the total is known, show motion rather than a
                      // bar stuck at zero.
                      progress.total === 0 && 'w-1/3 animate-pulse'
                    )}
                    style={progress.total > 0 ? { width: `${pct}%` } : undefined}
                  />
                </div>
                <div className="flex justify-between text-xs text-gray-500 tabular-nums">
                  <span>{progress.label || 'Working…'}</span>
                  {progress.total > 0 && (
                    <span>
                      {progress.done.toLocaleString()} / {progress.total.toLocaleString()} ({pct}%)
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 p-5 border-t border-gray-100 bg-gray-50/50 rounded-b-3xl">
            {state === 'confirm' && (
              <>
                <Button variant="outline" onClick={onClose}>Cancel</Button>
                <Button
                  onClick={onConfirm}
                  className="bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 text-white"
                >
                  {confirmLabel}
                </Button>
              </>
            )}
            {state === 'running' && (
              <span className="text-xs text-gray-500">This dialog closes when the job finishes.</span>
            )}
            {(state === 'done' || state === 'error') && (
              <Button onClick={onClose}>Close</Button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
