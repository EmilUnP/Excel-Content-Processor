import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { FileData, AppSettings } from '@/types';

interface ProcessingProgress {
  current: number;
  total: number;
  percentage: number;
  message: string;
  status: 'loading' | 'success' | 'error';
  estimatedTime?: string;
  showSpinner?: boolean;
}

interface AppState {
  // The file currently open in the table
  currentFile: FileData | null;

  // Processing
  isProcessing: boolean;
  processingProgress: ProcessingProgress;

  // UI State
  ui: {
    error: string | null;
    showTranslation: boolean;
    showModelSelection: boolean;
    showFileManager: boolean;
    fileManagerRefreshTrigger: number;
  };

  // Settings
  settings: AppSettings;
}

interface AppActions {
  setCurrentFile: (file: FileData | null) => void;

  setIsProcessing: (isProcessing: boolean) => void;
  setProcessingProgress: (progress: ProcessingProgress) => void;

  setError: (error: string | null) => void;
  setShowTranslation: (show: boolean) => void;
  setShowModelSelection: (show: boolean) => void;
  setShowFileManager: (show: boolean) => void;
  triggerFileManagerRefresh: () => void;

  setSelectedModel: (model: string) => void;
}

const idleProgress: ProcessingProgress = {
  current: 0,
  total: 0,
  percentage: 0,
  message: '',
  status: 'loading',
  estimatedTime: '',
  showSpinner: false
};

const initialState: AppState = {
  currentFile: null,
  isProcessing: false,
  processingProgress: idleProgress,
  ui: {
    error: null,
    showTranslation: false,
    showModelSelection: false,
    showFileManager: false,
    fileManagerRefreshTrigger: 0
  },
  settings: {
    selectedModel: 'gpt-5-nano'
  }
};

export const useAppStore = create<AppState & AppActions>()(
  devtools(
    persist(
      (set) => ({
        ...initialState,

        setCurrentFile: (file) => set({ currentFile: file }),

        setIsProcessing: (isProcessing) => set({ isProcessing }),
        setProcessingProgress: (progress) => set({ processingProgress: progress }),

        setError: (error) => set((state) => ({
          ui: { ...state.ui, error }
        })),
        setShowTranslation: (show) => set((state) => ({
          ui: { ...state.ui, showTranslation: show }
        })),
        setShowModelSelection: (show) => set((state) => ({
          ui: { ...state.ui, showModelSelection: show }
        })),
        setShowFileManager: (show) => set((state) => ({
          ui: { ...state.ui, showFileManager: show }
        })),
        triggerFileManagerRefresh: () => set((state) => ({
          ui: { ...state.ui, fileManagerRefreshTrigger: state.ui.fileManagerRefreshTrigger + 1 }
        })),

        setSelectedModel: (model) => set((state) => ({
          settings: { ...state.settings, selectedModel: model }
        }))
      }),
      {
        name: 'excel-processor-storage',
        // Only settings survive a reload. currentFile is deliberately excluded:
        // it can be many megabytes and it goes stale the moment the file on
        // disk changes.
        partialize: (state) => ({ settings: state.settings }),
        // An older build stored settings with many more fields. Merge over the
        // defaults so a stale entry can never leave selectedModel undefined.
        merge: (persisted, current) => {
          const saved = (persisted as Partial<AppState> | undefined)?.settings;
          return {
            ...current,
            settings: {
              ...current.settings,
              ...(saved?.selectedModel ? { selectedModel: saved.selectedModel } : {})
            }
          };
        }
      }
    )
  )
);
