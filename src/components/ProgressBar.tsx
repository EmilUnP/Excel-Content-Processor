'use client';

import React from 'react';
import { cn } from '@/lib/utils';
import { Loader2, CheckCircle, AlertCircle, Sparkles } from 'lucide-react';

interface ProgressBarProps {
  current: number;
  total: number;
  percentage: number;
  message: string;
  className?: string;
  status?: 'loading' | 'success' | 'error';
  showSpinner?: boolean;
  estimatedTime?: string;
}

export function ProgressBar({ 
  current, 
  total, 
  percentage, 
  message, 
  className,
  status = 'loading',
  showSpinner = true,
  estimatedTime
}: ProgressBarProps) {
  const getStatusConfig = () => {
    switch (status) {
      case 'success':
        return {
          bgGradient: 'from-emerald-500 to-teal-500',
          pulseColor: 'bg-emerald-500',
          iconColor: 'text-emerald-600',
          icon: <CheckCircle className="h-5 w-5 text-emerald-600" />
        };
      case 'error':
        return {
          bgGradient: 'from-red-500 to-rose-500',
          pulseColor: 'bg-red-500',
          iconColor: 'text-red-600',
          icon: <AlertCircle className="h-5 w-5 text-red-600" />
        };
      default:
        return {
          bgGradient: 'from-blue-500 via-cyan-500 to-indigo-500',
          pulseColor: 'bg-blue-500',
          iconColor: 'text-blue-600',
          icon: showSpinner ? <Loader2 className="h-5 w-5 animate-spin text-blue-600" /> : <Sparkles className="h-5 w-5 text-blue-600" />
        };
    }
  };

  const config = getStatusConfig();

  return (
    <div className={cn(
      // Above TranslationPanel (z-50) so progress stays readable after "Hide"
      "fixed top-0 left-0 right-0 z-[60] pointer-events-none",
      className
    )}>
      {/* Floating Card Container */}
      <div className="max-w-2xl mx-auto px-4 pt-6 pointer-events-auto">
        <div className="bg-white rounded-2xl shadow-2xl border border-gray-100 overflow-hidden animate-in slide-in-from-top duration-500">
          {/* Status Bar Indicator */}
          <div className="h-1.5 relative overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer" />
            <div 
              className={cn(
                "h-full bg-gradient-to-r transition-all duration-700 ease-out",
                config.bgGradient
              )}
              style={{ width: `${Math.min(percentage, 100)}%` }}
            />
          </div>

          {/* Card Content */}
          <div className="p-5 sm:p-6">
            {/* Header Row */}
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-start gap-4 flex-1 min-w-0">
                {/* Animated Icon Container */}
                <div className={cn(
                  "p-3 rounded-xl bg-gradient-to-br transition-all duration-300 shrink-0",
                  status === 'success' ? 'bg-emerald-50' : 
                  status === 'error' ? 'bg-red-50' : 
                  'bg-blue-50'
                )}>
                  <div className="relative">
                    {config.icon}
                    {status === 'loading' && (
                      <span className={cn(
                        "absolute inset-0 rounded-full animate-ping opacity-75",
                        config.pulseColor
                      )} />
                    )}
                  </div>
                </div>

                {/* Message Section */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-base font-bold text-gray-900 break-words">
                      {message || 'Processing…'}
                    </h3>
                    {estimatedTime && (
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                        {estimatedTime}
                      </span>
                    )}
                  </div>
                  
                  {/* Progress Stats */}
                  <div className="flex items-center gap-3 mt-2">
                    <div className="flex items-center gap-1.5 text-sm text-gray-600">
                      <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                      <span className="font-semibold tabular-nums">
                        {current.toLocaleString()}
                      </span>
                      <span className="text-gray-400">of</span>
                      <span className="font-bold text-gray-700 tabular-nums">
                        {total.toLocaleString()}
                      </span>
                      {status === 'loading' && total > 0 && (
                        <span className="text-gray-400">cells</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Progress Bar */}
            <div className="relative">
              <div className="w-full h-2.5 bg-gray-100 rounded-full overflow-hidden">
                <div 
                  className={cn(
                    "h-full bg-gradient-to-r transition-all duration-500 ease-out relative overflow-hidden",
                    config.bgGradient
                  )}
                  style={{ width: `${Math.min(percentage, 100)}%` }}
                >
                  {/* Animated shine effect */}
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-shimmer" />
                </div>
              </div>
              
              {/* Percentage Badge */}
              <div className="flex justify-end mt-2">
                <span className={cn(
                  "inline-flex items-center px-3 py-1 rounded-lg text-sm font-bold",
                  status === 'success' ? 'bg-emerald-100 text-emerald-700' :
                  status === 'error' ? 'bg-red-100 text-red-700' :
                  'bg-blue-100 text-blue-700'
                )}>
                  {percentage}%
                </span>
              </div>
            </div>

            {/* Steps Indicator (for debugging) */}
            {total > 1 && status === 'loading' && total < 20 && (
              <div className="flex items-center gap-1 mt-4 pt-4 border-t border-gray-100">
                <span className="text-xs text-gray-500 font-medium mr-2">Progress:</span>
                <div className="flex gap-1 flex-1">
                  {Array.from({ length: total }, (_, i) => (
                    <div
                      key={i}
                      className={cn(
                        "h-1.5 rounded-full transition-all duration-300 flex-1",
                        i < current 
                          ? cn("bg-blue-500", i === current - 1 && "animate-pulse") 
                          : "bg-gray-200"
                      )}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
