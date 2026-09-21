import * as XLSX from 'xlsx';
import { FileData, CellData } from '@/types';

// ============================================================================
// DELIMITED TEXT (CSV) SUPPORT
// ============================================================================

/** Extensions handled as delimited text rather than as a binary workbook. */
const DELIMITED_EXTENSIONS = ['.csv', '.tsv'];

/** Delimiters we try to recognise, in no particular order. */
const CANDIDATE_DELIMITERS = [',', ';', '\t', '|'];

export function isDelimitedTextFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return DELIMITED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Turns raw CSV bytes into text.
 *
 * A CSV carries no encoding declaration, so we have to work it out. A byte
 * order mark settles it outright. Without one we assume UTF-8 and verify with a
 * strict decoder: invalid byte sequences make it throw, which is exactly how a
 * Windows-1251 export (the usual shape of a Cyrillic CSV saved from Excel)
 * gives itself away.
 */
export function decodeDelimitedText(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Not valid UTF-8; fall back to the Cyrillic single-byte page.
    return new TextDecoder('windows-1251').decode(bytes);
  }
}

/** Counts delimiters that sit outside of quoted fields. */
function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes && char === delimiter) {
      count++;
    }
  }
  return count;
}

/**
 * Works out which character separates the fields.
 *
 * Excel writes semicolons in locales where the comma is the decimal separator,
 * so guessing "comma" is wrong often enough to matter. A real delimiter shows
 * up the same number of times on every row; stray punctuation inside the data
 * does not, which is what the consistency bonus below rewards.
 *
 * Quoted fields may legally contain newlines, so a naive line split can be
 * slightly off. That only affects this heuristic - SheetJS still does the real
 * parsing once the delimiter is chosen.
 */
export function detectDelimiter(text: string): string {
  const sample = text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(0, 5);

  if (sample.length === 0) return ',';

  let best = ',';
  let bestScore = -1;

  for (const delimiter of CANDIDATE_DELIMITERS) {
    const counts = sample.map((line) => countOutsideQuotes(line, delimiter));
    if (counts[0] === 0) continue;

    const isConsistent = counts.every((count) => count === counts[0]);
    const score = isConsistent ? counts[0] * 10 : counts[0];

    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }

  return best;
}

/**
 * Reads an uploaded spreadsheet into the app's cell model.
 *
 * Handles .xlsx / .xls workbooks and .csv / .tsv delimited text. The name is
 * kept for compatibility with existing callers.
 */
export async function processExcelFile(file: File): Promise<FileData> {
  const buffer = await file.arrayBuffer();

  let workbook: XLSX.WorkBook;

  if (isDelimitedTextFile(file.name)) {
    const text = decodeDelimitedText(buffer);
    // `raw: true` is not optional here. Without it SheetJS coerces numeric
    // looking fields, and an 18-digit question ID exceeds the exact range of a
    // double: 250112373304203237 comes back as 250112373304203230.
    workbook = XLSX.read(text, {
      type: 'string',
      FS: detectDelimiter(text),
      raw: true
    });
  } else {
    workbook = XLSX.read(buffer, { type: 'array' });
  }

  // Get the first worksheet
  const worksheetName = workbook.SheetNames[0];
  const worksheet = worksheetName ? workbook.Sheets[worksheetName] : undefined;

  // An empty upload (blank CSV, or a workbook with no sheets) would otherwise
  // fail further down with an unhelpful property access error.
  if (!worksheet) {
    throw new Error('The file appears to be empty - no sheet or rows were found.');
  }
  
  // Get the range of the worksheet
  const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1');
  
  const cells: CellData[] = [];
  let totalRows = 0;
  let totalColumns = 0;
  
  // Process each cell in the range
  for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex++) {
    totalRows = Math.max(totalRows, rowIndex + 1);
    
    for (let colIndex = range.s.c; colIndex <= range.e.c; colIndex++) {
      totalColumns = Math.max(totalColumns, colIndex + 1);
      
      // Get cell reference (e.g., A1, B2, etc.)
      const cellRef = XLSX.utils.encode_cell({ r: rowIndex, c: colIndex });
      const cell = worksheet[cellRef];
      
      // Get cell value, handling different data types
      let cellValue = '';
      if (cell) {
        if (cell.v !== undefined && cell.v !== null) {
          // Use the raw value, including 0
          cellValue = String(cell.v);
        } else if (cell.w) {
          // Use the formatted value
          cellValue = String(cell.w);
        }
      }
      
      // Handle empty cells properly - only treat as empty if truly empty
      let original = cellValue;
      
      // Fix math expressions in original field BEFORE processing
      original = fixMathExpressions(original);
      
      // Extract image data if present
      // NOTE: `imageData` is deliberately not stored here.
      //
      // It was always extracted *from* `original`, so every picture was held
      // twice in the same file - measured at 46% of a stored file's bytes, and
      // byte-identical in all 128 cases checked. Readers take the picture from
      // `original` and only fall back to `imageData`, so nothing is lost.
      //
      // The field still exists, and step 3 uses it: when an image is replaced
      // by a translated one, the untouched original is kept there.
      
      // Clean text (removing images)
      const cleaned = cleanText(original);
      
      cells.push({
        rowIndex,
        colIndex,
        original,
        cleaned,
        hasHtml: containsHtml(original),
        hasEntities: containsHtmlEntities(original),
        hasImages: containsImages(original),
        isEmpty: original === '' || original === null || original === undefined,
        paragraphCount: countParagraphs(cleaned)
      });
    }
  }

  // A blank upload still parses: SheetJS hands back a "Sheet1" with a one-cell
  // range. Without this check it would be stored as a useless single-cell file
  // and the user would get no hint that anything was wrong.
  if (!cells.some((cell) => !cell.isEmpty)) {
    throw new Error('The file appears to be empty - no data rows were found.');
  }
  
  return {
    id: `file_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    name: file.name,
    uploadDate: new Date().toISOString(),
    totalRows,
    totalColumns,
    cells
  };
}

/**
 * Converts superscripts and subscripts in HTML to Unicode characters
 * Example: <sup>2</sup> → ², <sub>2</sub> → ₂
 */
export function convertSupSubToUnicode(html: string): string {
  if (!html) return html;
  
  // Superscript digit mapping: 0-9 to ⁰-⁹
  const superscriptDigits: { [key: string]: string } = {
    '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
    '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
    '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
    'n': 'ⁿ', 'i': 'ⁱ'
  };
  
  // Subscript digit mapping: 0-9 to ₀-₉
  const subscriptDigits: { [key: string]: string } = {
    '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
    '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
    '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎'
  };
  
  // Convert <sup>content</sup> to superscript Unicode
  html = html.replace(/<sup[^>]*>([\s\S]*?)<\/sup>/gi, (match, content) => {
    // Remove any nested HTML tags first
    content = content.replace(/<[^>]+>/g, '').trim();
      // Decode any HTML entities that might be in the content
      content = content.replace(/&#(\d+);/g, (_m: string, num: string) => {
        const code = parseInt(num, 10);
        return code > 0xFFFF ? String.fromCodePoint(code) : String.fromCharCode(code);
      });
      // Convert each character to superscript if available
      return content.split('').map((char: string) => superscriptDigits[char] || char).join('');
  });
  
  // Convert <sub>content</sub> to subscript Unicode
  html = html.replace(/<sub[^>]*>([\s\S]*?)<\/sub>/gi, (match, content) => {
    // Remove any nested HTML tags first
    content = content.replace(/<[^>]+>/g, '').trim();
      // Decode any HTML entities that might be in the content
      content = content.replace(/&#(\d+);/g, (_m: string, num: string) => {
        const code = parseInt(num, 10);
        return code > 0xFFFF ? String.fromCodePoint(code) : String.fromCharCode(code);
      });
      // Convert each character to subscript if available
      return content.split('').map((char: string) => subscriptDigits[char] || char).join('');
  });
  
  return html;
}

/**
 * Fixes common mathematical expression encoding issues
 * - Converts Cyrillic п (&#1087;) to Greek π (&#960;) in mathematical contexts
 * - Removes control characters like line feeds from inside HTML tags
 */
export function fixMathExpressions(text: string): string {
  if (!text) return text;
  
  // Fix 1: Replace &#1087; (Cyrillic п) with &#960; (Greek π) where a number
  // comes first, which is the case this rule was written for: "2&#1087;" means
  // 2π, and "2&#1087;<sup>" means 2π².
  //
  // It used to fire on EVERY &#1087;, with the comment "ALWAYS, as it's
  // commonly misused for pi". In entity-encoded Russian - which is how these
  // workbooks store their text - that turns every п in every word into π, so
  // "Определите" becomes "Оπределите" before anything else sees it. The
  // translation model is then handed corrupted Russian and hands it straight
  // back untranslated. Measured on two real files: 1,686 of 1,686 π produced
  // this way were letters inside Cyrillic words, and none of them was maths.
  //
  // The two rules below already cover a decoded п in a genuine maths context.
  text = text.replace(/(\d)&#1087;/g, '$1&#960;');
  
  // Fix 1b: Handle already decoded Cyrillic п that appears in math contexts
  // Pattern: digit(s) + п + superscript/subscript/math operator
  text = text.replace(/(\d+)п(?=<(sup|sub)|[²³¹⁰⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿ+×÷=<>])/gi, '$1π');
  
  // Fix 1c: Handle п after digits even if no clear math operator (common math pattern)
  // Pattern: digit(s) + п + (whitespace/end/tag) - likely math context
  text = text.replace(/(\d+)п(?=\s|<\/|>|$)/g, '$1π');
  
  // Fix 2: Remove control character entities (like &#10;) from inside HTML tags
  // Pattern: <sup>content&#10;</sup> -> <sup>content</sup>
  text = text.replace(/(<(sup|sub)[^>]*>)([^<]*)&#10;([^<]*)(<\/\2>)/gi, (match, openTag, tagName, before, after, closeTag) => {
    // If before contains digits or math symbols, keep them, remove &#10; and after
    if (before.match(/[\d²³¹⁰⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿ]/)) {
      return openTag + before.trim() + closeTag;
    }
    // Otherwise, combine and trim
    const combined = (before + after).trim();
    return openTag + combined + closeTag;
  });
  
  // Fix 2b: Handle numeric line feed in sup/sub: <sup>2&#10;</sup> -> <sup>2</sup>
  // This catches cases where the number is directly before &#10;
  text = text.replace(/(<(sup|sub)[^>]*>)([0-9²³¹⁰⁴⁵⁶⁷⁸⁹]+)&#10;(<\/\2>)/gi, '$1$3$4');
  
  // Fix 2c: Handle line feed after digits in sup/sub: <sup>2&#10;</sup> -> <sup>2</sup>
  // More flexible pattern
  text = text.replace(/(<(sup|sub)[^>]*>)([0-9²³¹⁰⁴⁵⁶⁷⁸⁹]+)\s*&#10;\s*(<\/\2>)/gi, '$1$3$4');
  
  // Fix 3: Remove any remaining &#10; entities anywhere (line feeds shouldn't be in HTML content)
  text = text.replace(/&#10;/g, '');
  
  // Fix 4: Clean up multiple spaces that might have been created
  text = text.replace(/\s{2,}/g, ' ');
  
  return text;
}

function cleanText(text: string): string {
  if (!text) return '';
  
  // Remove base64 image data (keep only the text part)
  let cleaned = text.replace(/<img[^>]*src=["']data:image\/[^"']+["'][^>]*>/gi, '');
  cleaned = cleaned.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=\s]{50,}/gi, '');
  
  // Fix math expressions BEFORE decoding entities
  cleaned = fixMathExpressions(cleaned);
  
  // Use browser's native decoder for HTML entities (works on client-side)
  // On server-side, manually decode entities
  const decodeHTMLEntities = (html: string): string => {
    // Note: Browser's textarea.innerHTML decoder might not handle high Unicode correctly
    // So we use our custom decoder for both client and server
    // (The browser path below is kept as fallback but may not work for >65535 code points)
    
    // Fallback for Node.js environment
    return html
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      // Decode numeric entities WITH semicolon: &#120583;
      .replace(/&#(\d+);/g, (match, numStr) => {
        const charCode = parseInt(numStr, 10);
        // Validate the number is reasonable (Unicode range is 0x0 to 0x10FFFF = 1114111)
        if (isNaN(charCode) || charCode < 0 || charCode > 0x10FFFF) {
          return match; // Return unchanged if invalid
        }
        // Control characters and invisible chars become spaces
        if (charCode < 32 || (charCode >= 127 && charCode < 160)) {
          return ' ';
        }
        // Use fromCodePoint for Unicode code points beyond BMP (Basic Multilingual Plane)
        // fromCharCode only supports 0-65535, but we need to support up to 0x10FFFF
        if (charCode > 0xFFFF) {
          return String.fromCodePoint(charCode);
        }
        return String.fromCharCode(charCode);
      })
      // Decode numeric entities WITHOUT semicolon: &#120583 (match until space, >, <, or non-digit)
      .replace(/&#(\d+)(?=[^0-9<>&;]|$|<\/|>)/g, (match, numStr) => {
        const charCode = parseInt(numStr, 10);
        if (isNaN(charCode) || charCode < 0 || charCode > 0x10FFFF) {
          return match;
        }
        if (charCode < 32 || (charCode >= 127 && charCode < 160)) {
          return ' ';
        }
        if (charCode > 0xFFFF) {
          return String.fromCodePoint(charCode);
        }
        return String.fromCharCode(charCode);
      })
      // Decode hex entities WITH semicolon: &#x1D707;
      .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => {
        const charCode = parseInt(hex, 16);
        if (isNaN(charCode) || charCode < 0 || charCode > 0x10FFFF) {
          return match;
        }
        if (charCode < 32 || (charCode >= 127 && charCode < 160)) {
          return ' ';
        }
        if (charCode > 0xFFFF) {
          return String.fromCodePoint(charCode);
        }
        return String.fromCharCode(charCode);
      })
      // Decode hex entities WITHOUT semicolon: &#x1D707
      .replace(/&#x([0-9a-fA-F]+)(?![0-9a-fA-F])/gi, (match, hex) => {
        const charCode = parseInt(hex, 16);
        if (isNaN(charCode) || charCode < 0 || charCode > 0x10FFFF) {
          return match;
        }
        if (charCode < 32 || (charCode >= 127 && charCode < 160)) {
          return ' ';
        }
        if (charCode > 0xFFFF) {
          return String.fromCodePoint(charCode);
        }
        return String.fromCharCode(charCode);
      });
  };
  
  cleaned = decodeHTMLEntities(cleaned);
  
  // Convert superscripts/subscripts to Unicode BEFORE removing HTML tags
  // This preserves mathematical notation like 2² instead of losing it
  cleaned = convertSupSubToUnicode(cleaned);
  
  // Remove remaining HTML tags
  cleaned = cleaned.replace(/<[^>]*>/g, '');
  
  // Clean up extra whitespace and weird characters
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  
  return cleaned;
}

function containsHtml(text: string): boolean {
  return /<[^>]*>/g.test(text);
}

function containsHtmlEntities(text: string): boolean {
  return /&[a-zA-Z0-9#]+;/g.test(text);
}

function containsImages(text: string): boolean {
  if (!text) return false;
  
  // Check for image tags (including IMG tags)
  if (/<img[^>]*>/gi.test(text)) return true;
  
  // Check for markdown images
  if (/!\[.*?\]\(.*?\)/g.test(text)) return true;
  
  // Check for base64 encoded images (data:image/*;base64,)
  // This pattern matches data:image/png;base64, followed by at least 50 characters of base64
  if (/data:image\/[^;]+;base64,[A-Za-z0-9+/=\s]{50,}/i.test(text)) return true;
  
  // Check for very long base64 strings (which are likely images)
  // Look for base64 pattern without the data: prefix
  if (/base64,[A-Za-z0-9+/=\s]{200,}/i.test(text)) return true;
  
  // Check if the text is mostly base64-like characters (at least 80% base64 chars and length > 500)
  const base64CharPattern = /[A-Za-z0-9+/=\s]/g;
  const totalLength = text.length;
  if (totalLength > 500) {
    const base64Matches = text.match(base64CharPattern);
    const base64CharCount = base64Matches ? base64Matches.length : 0;
    const base64Percentage = base64CharCount / totalLength;
    if (base64Percentage > 0.8) return true;
  }
  
  return false;
}

function countParagraphs(text: string): number {
  if (!text.trim()) return 0;
  return text.split(/\n\s*\n/).filter(p => p.trim()).length;
}
