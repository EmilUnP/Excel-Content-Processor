export interface CellData {
  rowIndex: number;
  colIndex: number;
  original: string;
  cleaned: string;
  hasHtml: boolean;
  hasEntities: boolean;
  hasImages: boolean;
  isEmpty: boolean;
  paragraphCount: number;
  imageData?: string; // Extracted base64 image data
}

export interface FileData {
  id: string;
  name: string;
  uploadDate: string;
  totalRows: number;
  totalColumns: number;
  cells: CellData[];
}

/**
 * Persisted user preferences.
 *
 * Only settings the app actually reads live here. Fields that nothing consumed
 * (batch size, retry counts, export options, a second API key...) were removed
 * in 3.0 - they were editable in the UI but had no effect anywhere.
 */
export interface AppSettings {
  /** Model id chosen in the AI Model panel, e.g. "gemini-2.5-flash". */
  selectedModel: string;
}
