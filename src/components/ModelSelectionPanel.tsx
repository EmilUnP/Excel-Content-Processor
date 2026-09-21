'use client';

import React, { useState, useEffect } from 'react';
import { useAppStore } from '@/store/useAppStore';
import type { ModelOption } from '@/lib/model-config';
import { useEscapeToClose } from '@/hooks/useEscapeToClose';
import { Button } from '@/components/ui/button';
import { 
  X, 
  Cpu,
  CheckCircle
} from 'lucide-react';

export function ModelSelectionPanel() {
  const {
    ui,
    setShowModelSelection,
    settings,
    setSelectedModel
  } = useAppStore();

  const [selectedModel, setSelectedModelLocal] = useState(settings.selectedModel);

  /**
   * Provider status and the model list, both from the server.
   *
   * The models are defined in `.env` and read per request, so adding one is a
   * config change and a restart - no rebuild, and nothing to edit here.
   */
  const [provider, setProvider] = useState<{
    configured: boolean;
    label: string;
    translationModels: ModelOption[];
    defaultTranslationModel: string;
  } | null>(null);

  useEffect(() => {
    if (!ui.showModelSelection) return;
    let cancelled = false;
    fetch('/api/provider')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) setProvider(data);
      })
      .catch(() => {
        // Status is informational only - the picker works regardless.
      });
    return () => {
      cancelled = true;
    };
  }, [ui.showModelSelection]);

  // Escape closes the panel, like any other dialog.
  useEscapeToClose(ui.showModelSelection, () => setShowModelSelection(false));

  const models = provider?.translationModels ?? [];

  if (!ui.showModelSelection) return null;

  const handleSave = () => {
    setSelectedModel(selectedModel);
    setShowModelSelection(false);
  };


  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowModelSelection(false)} />
        
        <div className="relative w-full max-w-4xl bg-white rounded-3xl shadow-2xl border border-slate-200/50">
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b border-gray-100">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-gradient-to-br from-blue-100 to-blue-50 rounded-xl">
                <Cpu className="h-6 w-6 text-blue-600" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-gray-900">
                  Select AI Model
                </h2>
                <p className="text-sm text-gray-600 mt-0.5">
                  Choose the AI model used for translation
                </p>
                {provider && (
                  <p className="mt-1.5 inline-flex items-center gap-1.5 text-xs font-semibold">
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        provider.configured ? 'bg-green-500' : 'bg-red-500'
                      }`}
                    />
                    <span className={provider.configured ? 'text-gray-500' : 'text-red-600'}>
                      {provider.configured ? 'Served by OpenRouter' : provider.label}
                    </span>
                  </p>
                )}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowModelSelection(false)}
              className="h-8 w-8 p-0"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* Content */}
          <div className="p-6 max-h-[70vh] overflow-y-auto">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {models.map((model) => (
                <button
                  key={model.id}
                  onClick={() => setSelectedModelLocal(model.id)}
                  className={`p-5 rounded-xl border-2 text-left transition-all hover:shadow-md ${
                    selectedModel === model.id
                      ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200 shadow-sm'
                      : 'border-gray-200 hover:border-blue-300 hover:bg-gray-50'
                  }`}
                >
                  <div className="flex items-start justify-between mb-3 gap-2">
                    <div className="min-w-0">
                      <h4 className="font-bold text-gray-900 text-lg break-words">{model.name}</h4>
                      <p className="text-xs text-gray-500 mt-0.5">{model.provider}</p>
                    </div>
                    {model.id === provider?.defaultTranslationModel && (
                      <span className="flex-shrink-0 text-[11px] px-2 py-0.5 rounded font-bold bg-blue-100 text-blue-800">
                        DEFAULT
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 font-mono bg-gray-50 rounded-lg p-2 break-all">
                    {model.id}
                  </div>
                  {selectedModel === model.id && (
                    <div className="mt-4 flex items-center text-blue-600 font-semibold">
                      <CheckCircle className="h-4 w-4 mr-2" />
                      <span className="text-sm">Selected</span>
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end space-x-3 p-6 border-t border-gray-100">
            <Button
              variant="outline"
              onClick={() => setShowModelSelection(false)}
              className="hover:bg-gray-50"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              className="bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 text-white shadow-sm hover:shadow-md transition-all"
            >
              <CheckCircle className="h-4 w-4 mr-2" />
              Save Model Selection
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
