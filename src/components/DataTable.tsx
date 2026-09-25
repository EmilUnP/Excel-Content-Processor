'use client';

import React, { useState, useMemo, useEffect, useCallback, useRef, ReactNode } from 'react';
import { CellData, FileData } from '@/types';
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ActionDialog, ActionDialogState, ActionProgress } from '@/components/ActionDialog';
import { IMAGE_TEXT_LANGUAGES, ImageTextLanguage } from '@/lib/image-text-service';
import { DEFAULT_IMAGE_TRANSLATE_MODEL, IMAGE_TRANSLATE_MODELS } from '@/lib/image-translate-service';
import { 
  Edit2, 
  Trash2, 
  AlertCircle,
  CheckCircle,
  Image as ImageIcon,
  Code,
  FileText,
  Check,
  X,
  HelpCircle,
  ScanText,
  Languages,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  FileSpreadsheet
} from 'lucide-react';
import { cn } from '@/lib/utils';
import * as XLSX from 'xlsx';
import { fixMathExpressions } from '@/lib/excel-processor';
import { analyzeImageQuestions, extractImageTags, isCodeColumn } from '@/lib/question-model';

// ============================================================================
// SHARED UTILITY FUNCTIONS (to avoid duplication)
// ============================================================================

/**
 * Real `<img>` tags for export — same source the UI / HTML export use.
 * Never invents `[IMAGE]` placeholders.
 */
function collectExportImageTags(cell: CellData): string[] {
  const fromOriginal = extractImageTags(cell.original);
  if (fromOriginal.length > 0) return fromOriginal;

  const loose = cell.original?.match(/<img[^>]*>/gi) || [];
  if (loose.length > 0) return loose;

  if (cell.imageData?.startsWith('data:image')) {
    return [`<img src="${cell.imageData}" alt="question image" />`];
  }
  return [];
}

/**
 * Builds one cell the way HTML export does: translated text + real image HTML.
 * Strips leftover `[IMAGE]` / `[IMAGE_DATA]` placeholders from translation.
 */
function buildExportCellContent(
  cell: CellData,
  formatText?: (text: string) => string
): { text: string; images: string[]; html: string } {
  let text = cell.cleaned || '';
  if (!text.trim() || text.trim().toLowerCase() === 'null') {
    text = '';
  }

  text = text
    .replace(/\[IMAGE_DATA\]/gi, '')
    .replace(/\[IMAGE\]/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // If cleaned already holds full data-URL images, keep them; otherwise drop
  // any stub <img> and attach the real ones from original.
  const cleanedImgs = text.match(/<img[^>]*>/gi) || [];
  const cleanedHasFullImages = cleanedImgs.some(
    (tag) => /data:image\//i.test(tag) && tag.length > 200
  );

  if (!cleanedHasFullImages) {
    text = text.replace(/<img[^>]*>/gi, '').trim();
  }

  if (formatText && text) {
    text = formatText(text);
  }

  const images = cleanedHasFullImages ? cleanedImgs : collectExportImageTags(cell);
  // When cleaned already had full images, they are inside `text` — don't duplicate
  const imageSuffix = cleanedHasFullImages ? [] : images;
  const html = imageSuffix.length > 0
    ? (text ? `${text}${imageSuffix.join('')}` : imageSuffix.join(''))
    : text;

  return { text, images: imageSuffix, html };
}

/**
 * Cleans HTML entities from text
 */
const cleanEntities = (str: string): string => {
  return str
    // CRITICAL: Remove line feed entities first (&#10; breaks words incorrectly)
    .replace(/&#10;/g, ' ')
    // Convert <br> and <br/> tags to spaces (not paragraph breaks for inline content)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Handle decimal entities WITH semicolon: &#120583;
    .replace(/&#\d+;/g, (match) => {
      const numStr = match.replace(/[&#;]/g, '');
      const num = parseInt(numStr, 10);
      // Validate the number is reasonable (Unicode range is 0x0 to 0x10FFFF = 1114111)
      if (isNaN(num) || num < 0 || num > 0x10FFFF) {
        console.warn(`Invalid entity code point: ${match}, parsed as ${num}`);
        return match; // Return unchanged if invalid
      }
      // Convert control characters (including line feed, tab, etc.) to spaces
      if (num < 32 || num === 127) {
        return ' '; // Control chars become space
      }
      let result: string;
      if (num > 0xFFFF) {
        result = String.fromCodePoint(num);
      } else {
        result = String.fromCharCode(num);
      }
      // Debug: Log high Unicode characters that might have display issues
      if (num === 120583) {
        console.log(`Decoded entity ${match} to character: "${result}" (U+${num.toString(16).toUpperCase()})`);
      }
      return result;
    })
    // Handle decimal entities WITHOUT semicolon: &#120538 (match until space, >, <, or non-digit)
    .replace(/&#(\d+)(?=[^0-9<>&;]|$|<\/|>)/g, (match, numStr) => {
      const num = parseInt(numStr, 10);
      // Convert control characters to spaces
      if (num < 32 || num === 127) {
        return ' ';
      }
      if (num > 0xFFFF) {
        return String.fromCodePoint(num);
      }
      return String.fromCharCode(num);
    })
    // Handle hex entities WITH semicolon: &#x1D707;
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => {
      const num = parseInt(hex, 16);
      // Convert control characters to spaces
      if (num < 32 || num === 127) {
        return ' ';
      }
      if (num > 0xFFFF) {
        return String.fromCodePoint(num);
      }
      return String.fromCharCode(num);
    })
    // Handle hex entities WITHOUT semicolon: &#x1D707
    .replace(/&#x([0-9a-fA-F]+)(?![0-9a-fA-F])/gi, (match, hex) => {
      const num = parseInt(hex, 16);
      // Convert control characters to spaces
      if (num < 32 || num === 127) {
        return ' ';
      }
      if (num > 0xFFFF) {
        return String.fromCodePoint(num);
      }
      return String.fromCharCode(num);
    });
};

/**
 * Converts Roman numerals to integers
 */
const romanToInt = (roman: string): number => {
  const romanMap: { [key: string]: number } = {
    'I': 1, 'V': 5, 'X': 10, 'L': 50, 'C': 100, 'D': 500, 'M': 1000
  };
  let result = 0;
  for (let i = 0; i < roman.length; i++) {
    const current = romanMap[roman[i]] || 0;
    const next = romanMap[roman[i + 1]] || 0;
    if (current < next) {
      result -= current;
    } else {
      result += current;
    }
  }
  return result;
};

/**
 * Formats text as paragraphs with smart list detection
 * This is a shared function used by both Excel+HTML and HTML export
 * @param text - The text to format
 * @param colIndex - Column index (for determining if column should be formatted)
 * @param shouldFormatColumn - Optional function to check if column should be formatted
 */
const formatAsParagraphs = (
  text: string, 
  colIndex?: number,
  shouldFormatColumn?: (colIndex: number, cellValue: string) => boolean
): string => {
  if (!text || !text.trim()) return '';
  
  // FIRST: Fix math expressions BEFORE decoding entities
  text = fixMathExpressions(text);
  
  // THEN: Decode HTML entities
  text = cleanEntities(text);
  
  // NOTE: DO NOT re-clean Gemini translation errors here
  // The text from JSON is already in its final cleaned form
  // Re-applying cleaning would undo our fixes (like "var b." → "varb.")
  
  // Check if this column should be formatted (if shouldFormatColumn is provided)
  if (colIndex !== undefined && shouldFormatColumn && !shouldFormatColumn(colIndex, text)) {
    return text;
  }
  
  let cleanedText = text;
  
  // If text contains HTML paragraph tags, extract and preserve them
  if (text.includes('</p>')) {
    const paragraphs = text.match(/<p[^>]*>([\s\S]*?)<\/p>/g);
    if (paragraphs && paragraphs.length > 0) {
      return paragraphs.map(p => {
        // Decode entities FIRST before removing tags (entities may be inside span tags)
        let clean = cleanEntities(p);
        // Then remove all HTML tags (including <p> tags)
        // Remove HTML tags but PRESERVE math symbols < and >
        // Only remove actual HTML tags (like <span>, <p>, etc.), not standalone < or > characters
        clean = clean.replace(/<\/?[a-zA-Z][a-zA-Z0-9]*[^>]*>/g, '');
        clean = clean.replace(/<[a-zA-Z][a-zA-Z0-9]*[^>]*\/>/g, '');
        clean = clean.trim();
        clean = clean.replace(/\s+/g, ' ');
        // NOTE: DO NOT re-clean here - text is already cleaned from JSON
        // Re-applying would undo fixes like "var b." → "varb."
        return `<p>${clean}</p>`;
      }).filter(p => p.length > 0).join('\n');
    }
  }
  
  // Remove HTML tags for processing
  // Remove HTML tags but PRESERVE math symbols < and >
  // Only remove actual HTML tags (like <span>, <p>, etc.), not standalone < or > characters
  cleanedText = cleanedText.replace(/<\/?[a-zA-Z][a-zA-Z0-9]*[^>]*>/g, '');
  cleanedText = cleanedText.replace(/<[a-zA-Z][a-zA-Z0-9]*[^>]*\/>/g, '');
  
  // CRITICAL: Merge split words BEFORE cleanEntities (which converts newlines to spaces)
  // Fix split words like "bər\n\n\nk)" → "bərk)" or "word\nletter)" → "wordletter)"
  // Pattern: word characters (2+ chars) + whitespace/newlines + word characters (1-3 chars) + closing paren/period
  // Also handle cases inside parentheses: (bər\nk) → (bərk)
  // More aggressive pattern to catch all newline variations (BEFORE they're converted to spaces)
  cleanedText = cleanedText.replace(/([a-zа-яәəıöüğşçA-ZА-ЯӘƏİÖÜĞŞÇ]{2,})\s*[\n\r]+\s*([a-zа-яәəıöüğşçA-ZА-ЯӘƏİÖÜĞŞÇ]{1,3})([\)\.])/gi, (match, wordPart1, wordPart2, punct) => {
    // Only merge if the second part is very short (1-3 chars) - likely a split word
    // Don't merge if second part starts with capital (likely new sentence/word)
    // This handles cases like "bər\n\n\nk)" → "bərk)"
    if (wordPart2.length <= 3 && !/^[А-ЯӘƏİÖÜĞŞÇA-Z]/.test(wordPart2)) {
      return wordPart1 + wordPart2 + punct;
    }
    return match;
  });
  
  // Now decode entities (this may convert some newlines to spaces, but we've already merged split words)
  cleanedText = cleanEntities(cleanedText);
  
  // Also handle cases where split words appear as multiple spaces (after entity decoding)
  // Pattern: word + multiple spaces (2+) + short word (1-3 chars) + closing paren/period
  // This catches cases where newlines were already converted to spaces by first cleanEntities call
  cleanedText = cleanedText.replace(/([a-zа-яәəıöüğşçA-ZА-ЯӘƏİÖÜĞŞÇ]{2,})\s{2,}([a-zа-яәəıöüğşçA-ZА-ЯӘƏİÖÜĞŞÇ]{1,3})([\)\.])/gi, (match, wordPart1, wordPart2, punct) => {
    // Only merge if second part is very short (1-3 chars) and not capitalized
    if (wordPart2.length <= 3 && !/^[А-ЯӘƏİÖÜĞŞÇA-Z]/.test(wordPart2)) {
      return wordPart1 + wordPart2 + punct;
    }
    return match;
  });
  
  cleanedText = cleanedText.replace(/\s+/g, ' ').trim();
  
  // FIX: Add missing spaces BEFORE and AFTER numbered/lettered markers
  // First, fix letter markers stuck to words (e.g., "molb." → "mol b." or "molc." → "mol c.")
  // Pattern: word (2+ chars) + single letter (a-z) + period/paren + (space or number or capital or end)
  // This handles cases like "kC/molb. 4n" → "kC/mol b. 4n" or "molc. 2n" → "mol c. 2n"
  cleanedText = cleanedText.replace(/([a-zа-яәəıöüğşçA-ZА-ЯӘƏİÖÜĞŞÇ]{2,})([a-z])([\.\)])(\s|$|[0-9А-ЯӘƏİÖÜĞŞÇA-Z])/gi, (match, word, letter, punct, after) => {
    // Only add space if it looks like a marker pattern
    // A single lowercase letter a-z followed by period/paren and space/number/capital is almost certainly a marker
    if (/^[a-z]$/i.test(letter)) {
      // Always break if followed by number or capital letter (definitely a marker)
      if (after.match(/^[0-9А-ЯA-Z]/)) {
        return word + ' ' + letter + punct + after;
      }
            // Also break if followed by space (likely a marker)
      // Common marker pattern: short word (3-5 chars) + single letter (a-g) + period/paren + space
      // Examples: "molb.", "molc.", "nold.", "nole." → "mol b.", "mol c.", "nol d.", "nol e."
      if (after.match(/^\s/) && word.length >= 2 && word.length <= 5 && /^[a-g]$/i.test(letter)) {
        return word + ' ' + letter + punct + after;
      }
    }
    return match;
  });
  
  // Fix patterns like "1.Гидратация" → "1. Гидратация" or "5)Одноосновной" → "5) Одноосновной"
  // Only fix when there's NO space after the marker (preserve original marker format)
  cleanedText = cleanedText.replace(/([1-9]\d?)([\.\)])([А-ЯӘƏİÖÜĞŞÇA-Zа-яәəıöüğşç])/g, '$1$2 $3');
  cleanedText = cleanedText.replace(/([a-z])([\.\)])([А-ЯӘƏİÖÜĞŞÇA-Zа-яәəıöüğşç])/gi, '$1$2 $3');
  // Also fix uppercase letter markers (A. B. C.) - ensure space after period
  cleanedText = cleanedText.replace(/([A-Z])(\.)([А-ЯӘƏİÖÜĞŞÇA-Zа-яәəıöüğşç])/g, '$1$2 $3');
  
  // ADVANCED LIST DETECTION - Finds ALL markers (numbered AND lettered) and splits at each
  
  // Step 1: Find ALL potential list markers (numbered AND lettered) with space after
  // Support BOTH formats: periods (1. 2.) and parentheses (1) 2))
  // Support multi-digit numbers: 1-9, 10-99 (e.g., 10. 11. 12.)
  // More flexible: match markers after space, newline, or start of text
  const numberedPatternPeriod = /(?:^|\s)([1-9]\d?)\.\s+/g; // Matches 1-9 or 10-99
  const numberedPatternParen = /(?:^|\s)([1-9]\d?)\)\s+/g; // Matches 1-9 or 10-99
  const letteredPatternPeriod = /(?:^|\s)([A-Za-z])\.\s+/g; // Matches uppercase and lowercase letters (A. B. or a. b.)
  const letteredPatternParen = /(?:^|\s)([A-Za-z])\)\s+/g; // Matches uppercase and lowercase letters (A) B) or a) b)
  
  // Pattern for Roman numerals (I., II., III., IV., V., etc.)
  const romanPatternPeriod = /(?:^|\s)([IVXLCDM]+)\.\s+/g; // Matches Roman numerals with periods
  
  const allMatches: Array<{ pos: number; marker: string; type: 'number' | 'letter' | 'roman'; value: number; format: 'period' | 'paren' }> = [];
  
  let match;
  
  // Find numbered markers with periods (1. 2. 3.)
  while ((match = numberedPatternPeriod.exec(cleanedText)) !== null) {
    const afterPos = match.index + match[0].length;
    const afterChar = cleanedText[afterPos];
    if (afterChar && afterChar.trim().length > 0) {
      const markerPos = match[0].startsWith(' ') ? match.index + 1 : match.index;
      allMatches.push({ 
        pos: markerPos, 
        marker: match[1], 
        type: 'number',
        value: parseInt(match[1]),
        format: 'period'
      });
    }
  }
  
  // Find numbered markers with parentheses (1) 2) 3))
  numberedPatternParen.lastIndex = 0;
  while ((match = numberedPatternParen.exec(cleanedText)) !== null) {
    const afterPos = match.index + match[0].length;
    const afterChar = cleanedText[afterPos];
    if (afterChar && afterChar.trim().length > 0) {
      // Calculate position: if match starts with space, point to number; otherwise point to start of match
      // For pattern /(?:^|\s)([1-9]\d?)\)\s+/g, match[0] is like " 1) " or "1) "
      // We want markerPos to point to the start of the number (before the closing parenthesis)
      const markerPos = match[0].startsWith(' ') ? match.index + 1 : match.index;
      allMatches.push({ 
        pos: markerPos, 
        marker: match[1], 
        type: 'number',
        value: parseInt(match[1]),
        format: 'paren'
      });
    }
  }
  
  // Find lettered markers with periods (a. b. c.)  
  // Skip single Roman numeral characters (I, V, X, L, C, D, M) - they're handled by Roman pattern
  letteredPatternPeriod.lastIndex = 0;
  const letterMarkers: Array<{ pos: number; marker: string; value: number }> = [];
  while ((match = letteredPatternPeriod.exec(cleanedText)) !== null) {
    const afterPos = match.index + match[0].length;
    const afterChar = cleanedText[afterPos];
    const matchedLetter = match[1].toUpperCase();
    // Skip if it's a single Roman numeral character (I, V, X, L, C, D, M)
    // These will be caught by the Roman numeral pattern instead
    if (/^[IVXLCDM]$/.test(matchedLetter)) {
      continue;
    }
    if (afterChar && /[A-ZА-ЯӘƏİÖÜĞŞÇa-zа-яәəıöüğşçа-я]/.test(afterChar)) {
      const markerPos = match[0].startsWith(' ') ? match.index + 1 : match.index;
      letterMarkers.push({
        pos: markerPos,
        marker: match[1],
        value: match[1].toLowerCase().charCodeAt(0) - 96
      });
    }
  }
  
  // Filter letter markers: Only keep if they appear in sequence (at least 2 consecutive)
  // or if they're at the start of text/paragraph
  // This prevents single letters like X, Y, Z in scientific text from being treated as markers
  // BUT: If we have 2+ letter markers (like A. B.), keep ALL of them as they're clearly a list
  if (letterMarkers.length >= 2) {
    // If we have multiple letter markers, keep ALL of them - they're clearly part of a list
    for (const marker of letterMarkers) {
      allMatches.push({
        pos: marker.pos,
        marker: marker.marker,
        type: 'letter',
        value: marker.value,
        format: 'period'
      });
    }
  } else {
    // Single letter marker - apply stricter filtering
    for (let i = 0; i < letterMarkers.length; i++) {
      const marker = letterMarkers[i];
      let shouldKeep = false;
      
      // Check if it's at the start of text or after newline
      const textBefore = cleanedText.substring(Math.max(0, marker.pos - 50), marker.pos);
      const isAtStart = marker.pos < 20 || /^[\s\n]*$/.test(textBefore);
      
      // Check if there are adjacent letter markers (within 500 chars, sequential values)
      const hasAdjacentMarkers = letterMarkers.some((other, idx) => {
        if (idx === i) return false;
        const distance = Math.abs(other.pos - marker.pos);
        const valueDiff = Math.abs(other.value - marker.value);
        // Adjacent if within 500 chars and values are close (within 5 positions)
        return distance < 500 && valueDiff > 0 && valueDiff <= 5;
      });
      
      // Keep if: at start OR has adjacent markers (suggesting it's part of a list)
      shouldKeep = isAtStart || hasAdjacentMarkers;
      
      if (shouldKeep) {
        allMatches.push({
          pos: marker.pos,
          marker: marker.marker,
          type: 'letter',
          value: marker.value,
          format: 'period'
        });
      }
    }
  }
  
  // Find lettered markers with parentheses (a) b) c))  
  letteredPatternParen.lastIndex = 0;
  while ((match = letteredPatternParen.exec(cleanedText)) !== null) {
    const afterPos = match.index + match[0].length;
    const afterChar = cleanedText[afterPos];
    
    // Skip if it's likely part of a split word (e.g., "bər\nk)" should not be treated as "k)" marker)
    // Check if there's word-like text before the marker followed by a newline
    // This is a fallback check in case the word merging above didn't catch it
    const beforePos = match.index;
    const textBefore = cleanedText.substring(Math.max(0, beforePos - 50), beforePos);
    // Check for: word (2+ chars) + newline(s) + end of string before marker
    // OR: word (2+ chars) + newline(s) + very short text (1-3 chars) + end
    const hasWordBeforeNewline = /[a-zа-яәəıöüğşç]{2,}\s*\n+\s*$/i.test(textBefore) ||
                                 /[a-zа-яәəıöüğşç]{2,}\s*\n+\s*[a-zа-яәəıöüğşç]{0,2}$/i.test(textBefore);
    if (hasWordBeforeNewline) {
      continue; // Skip this - it's part of a split word
    }
    
    if (afterChar && /[A-ZА-ЯӘƏİÖÜĞŞÇa-zа-яәəıöüğşçа-я]/.test(afterChar)) {
      const markerPos = match[0].startsWith(' ') ? match.index + 1 : match.index;
      allMatches.push({ 
        pos: markerPos, 
        marker: match[1], 
        type: 'letter',
        value: match[1].toLowerCase().charCodeAt(0) - 96,
        format: 'paren'
      });
    }
  }
  
  // Find Roman numeral markers with periods (I. II. III. IV. etc.)
  romanPatternPeriod.lastIndex = 0;
  while ((match = romanPatternPeriod.exec(cleanedText)) !== null) {
    const afterPos = match.index + match[0].length;
    const afterChar = cleanedText[afterPos];
    if (afterChar && afterChar.trim().length > 0) {
      const markerPos = match[0].startsWith(' ') ? match.index + 1 : match.index;
      const romanValue = romanToInt(match[1]);
      // Only add if it's a valid Roman numeral (value > 0)
      if (romanValue > 0) {
        allMatches.push({ 
          pos: markerPos, 
          marker: match[1], 
          type: 'roman',
          value: romanValue,
          format: 'period'
        });
      }
    }
  }
  
  // Sort all markers by position (so we process them in order they appear)
  allMatches.sort((a, b) => a.pos - b.pos);
  
  // Step 2: Validate - need at least 2 markers total (changed from 3 to support lists like "I. ... II. ..." or "A. ... B. ...")
  if (allMatches.length >= 2) {
    // Group consecutive markers of the same type that are CLOSE TOGETHER
    // This prevents mixing two separate lists (e.g., two lists both numbered 1-8)
    const groups: Array<typeof allMatches> = [];
    let currentGroup: typeof allMatches = [allMatches[0]];
    
    // Maximum distance between consecutive markers in the same list (characters)
    // If markers are further apart, they belong to separate lists
    const MAX_DISTANCE = 200; // Characters
    
    for (let i = 1; i < allMatches.length; i++) {
      const prevMarker = allMatches[i - 1];
      const currMarker = allMatches[i];
      const distance = currMarker.pos - prevMarker.pos;
      
      // Check for section separators (colon followed by capital letter, section headers, or large gaps)
      const textBetween = cleanedText.substring(prevMarker.pos, currMarker.pos);
      // Look for section headers like "Funksiyalar:", "Orqanoidlər:" etc.
      const hasSectionSeparator = /:\s*[A-ZА-ЯӘƏİÖÜĞŞÇ]/.test(textBetween) || 
                                  /[A-ZА-ЯӘƏİÖÜĞŞÇ][a-zа-яәəıöüğşçа-я]+:\s*$/.test(textBetween) || // Word ending with colon at end
                                  textBetween.includes('\n') ||
                                  distance > MAX_DISTANCE ||
                                  // If the sequence restarts (e.g., we see 1 after 8), likely new list
                                  (currMarker.type === prevMarker.type && 
                                   currMarker.value === 1 && 
                                   prevMarker.value > 5 &&
                                   distance > 100);
      
      // If same type AND close together AND no section separator, add to current group
      if (currMarker.type === currentGroup[0].type && 
          distance < MAX_DISTANCE && 
          !hasSectionSeparator) {
        currentGroup.push(currMarker);
      } else {
        // Start a new group
        if (currentGroup.length >= 2) {
          groups.push([...currentGroup]);
        }
        currentGroup = [currMarker];
      }
    }
    if (currentGroup.length >= 2) {
      groups.push(currentGroup);
    }
    
    // Check each group for sequential markers
    const validGroups = groups.filter(group => {
      if (group.length < 2) return false;
      
      const values = group.map(m => m.value);
      const sequenceStart = values[0];
      
      // Check if sequential (allow gap of 1)
      for (let i = 0; i < values.length; i++) {
        const expected = sequenceStart + i;
        const diff = Math.abs(values[i] - expected);
        if (diff > 1) return false;
      }
      
      return true;
    });
    
    // Handle nested lists: if we have multiple groups with different types that are interleaved,
    // merge them into one unified list (e.g., numbered + lettered = nested structure)
    // Example: "1. Item a. sub-item 2. Item b. sub-item" should be processed together
    let mergedMarkerList: typeof allMatches = [];
    if (validGroups.length >= 2) {
      // Check if groups are interleaved (nested structure)
      // If numbered markers have lettered markers between them, it's a nested list
      const numberedGroup = validGroups.find(g => g[0].type === 'number');
      const letteredGroup = validGroups.find(g => g[0].type === 'letter');
      
      if (numberedGroup && letteredGroup) {
        // Check if lettered markers appear between numbered markers
        const firstNumberedPos = numberedGroup[0].pos;
        const lastNumberedPos = numberedGroup[numberedGroup.length - 1].pos;
        const firstLetteredPos = letteredGroup[0].pos;
        const lastLetteredPos = letteredGroup[letteredGroup.length - 1].pos;
        
        // If lettered markers are within the range of numbered markers, it's nested
        if (firstLetteredPos >= firstNumberedPos && lastLetteredPos <= lastNumberedPos + 500) {
          // Merge: combine all markers and sort by position
          mergedMarkerList = [...numberedGroup, ...letteredGroup].sort((a, b) => a.pos - b.pos);
        }
      }
    }
    
    // Check if any valid group is an INLINE LIST (items separated by semicolons)
    // Inline lists like "1) Na; 2) K; 3) Si; 4) Mg; 5) C." should NOT be split
    // BUT structured lists (longer items, multiple words) SHOULD be split into separate items
    // AND if list ends with period and next sentence starts with capital letter, split at sentence boundary
    const inlineListGroups: typeof validGroups = [];
    const hasInlineList = validGroups.some(group => {
      if (group.length < 2) return false;
      
      // Check if consecutive items are separated by semicolons (inline format)
      let isInline = false;
      let allItemsShort = true; // Track if all items are short (likely inline)
      
      // Check ALL items in the group first to determine if they're all truly short
      for (let i = 0; i < group.length; i++) {
        let itemText: string;
        if (i < group.length - 1) {
          itemText = cleanedText.substring(group[i].pos, group[i + 1].pos).trim();
        } else {
          // Last item - get text until end or next group
          itemText = cleanedText.substring(group[i].pos).trim();
        }
        
        const wordCount = itemText.split(/\s+/).filter(w => w.length > 0).length;
        // Stricter criteria: Only treat as short if it's a single word OR very short (< 15 chars)
        // Items with 2+ words should always be split into separate paragraphs
        const isShortItem = (itemText.length < 15 || wordCount === 1) && itemText.length < 30;
        
        if (!isShortItem) {
          allItemsShort = false; // Found a longer item - this is NOT an inline list
        }
      }
      
      // Check if ALL items end with semicolons (strong indicator of structured list)
      let allItemsEndWithSemicolon = true;
      for (let i = 0; i < group.length; i++) {
        let itemText: string;
        if (i < group.length - 1) {
          itemText = cleanedText.substring(group[i].pos, group[i + 1].pos).trim();
        } else {
          itemText = cleanedText.substring(group[i].pos).trim();
        }
        // Check if item ends with semicolon (may be followed by whitespace)
        if (!/;\s*$/.test(itemText)) {
          allItemsEndWithSemicolon = false;
          break;
        }
      }

      // If ALL items are short AND ALL end with semicolons, default to STRUCTURED (separate paragraphs)
      // Only treat as inline if ALL items are VERY compact (likely all on one line)
      if (allItemsShort && allItemsEndWithSemicolon) {
        // Check if the entire list is very compact (inline format like "1) Na; 2) K; 3) Si; 4) Mg; 5) C.")
        // For truly inline lists, items are very close together
        // Check if average distance between consecutive items is very small (< 10 chars)
        let totalDistance = 0;
        let allVeryClose = true;
        for (let i = 0; i < group.length - 1; i++) {
          const distance = group[i + 1].pos - group[i].pos;
          totalDistance += distance;
          // If any items are more than 10 chars apart, they're likely on separate lines
          if (distance > 10) {
            allVeryClose = false;
            break;
          }
        }
        
        // Only treat as inline if ALL items are very close together AND list is compact
        if (allVeryClose && group.length <= 8) {
          isInline = true;
        } else {
          // Items are spaced apart or list is long - treat as structured (separate paragraphs)
          isInline = false;
        }
      } else if (allItemsShort) {
        // Some items don't end with semicolons - use original logic
        for (let i = 0; i < group.length - 1; i++) {
          const currentMarker = group[i];
          const nextMarker = group[i + 1];
          const textBetween = cleanedText.substring(currentMarker.pos, nextMarker.pos);
          const itemText = textBetween.trim();

          const distance = nextMarker.pos - currentMarker.pos;
          const hasSemicolonSeparator = textBetween.includes(';');
          const noLineBreak = !textBetween.includes('\n');

          const wordCount = itemText.split(/\s+/).filter(w => w.length > 0).length;
          const isShortItem = (itemText.length < 15 || wordCount === 1) && itemText.length < 30;

          if (hasSemicolonSeparator && noLineBreak && distance < 100 && isShortItem) {
            isInline = true;
          } else if (hasSemicolonSeparator && !isShortItem) {
            isInline = false;
            break;
          }
        }
      }
      
      // Only treat as inline if ALL items are short AND meet inline criteria
      if (isInline && allItemsShort) {
        inlineListGroups.push(group);
        return true;
      }
      return false;
    });
    
    // For inline lists, check if we should split at sentence boundary
    // Pattern: "List ends with period" + space + "Capital letter starts new sentence"
    if (hasInlineList && inlineListGroups.length > 0) {
      const inlineGroup = inlineListGroups[0]; // Take first inline list
      const lastMarker = inlineGroup[inlineGroup.length - 1];
      
      // Search from the last marker position forward to find sentence boundary
      // Pattern: period followed by spaces followed by capital letter (new sentence)
      const searchFrom = lastMarker.pos;
      const searchText = cleanedText.substring(searchFrom);
      
      // Match: period + one or more spaces + capital letter
      const sentenceBoundaryPattern = /\.\s+([А-ЯӘƏİÖÜĞŞÇA-Z])/;
      const match = searchText.match(sentenceBoundaryPattern);
      
      if (match && match.index !== undefined) {
        // Found sentence boundary after the period
        // boundaryPos is where the period is, we want to split after the period and spaces
        const periodPos = searchFrom + match.index;
        const afterPeriod = periodPos + 1; // After the period
        // Find where spaces end and capital letter starts
        let spacesEnd = afterPeriod;
        while (spacesEnd < cleanedText.length && cleanedText[spacesEnd] === ' ') {
          spacesEnd++;
        }
        // spacesEnd now points to the capital letter (start of new sentence)
        
        // Split at sentence boundary: inline list becomes one paragraph, rest is another
        // Keep period in first paragraph (don't trim before spacesEnd)
        const listText = cleanedText.substring(0, spacesEnd).trim();
        const restText = cleanedText.substring(spacesEnd).trim();
        
        // Make sure we have meaningful content in both parts (at least intro text + list items, and question)
        if (listText.length > 10 && restText.length > 10) {
          return `<p>${listText}</p>\n<p>${restText}</p>`;
        }
      }
    }
    
    // If we have at least one valid group AND it's NOT an inline list, format each group separately
    // Inline lists should stay together in one paragraph (unless split at sentence boundary above)
    if (validGroups.length > 0 && !hasInlineList) {
      // If we have a merged marker list (nested lists), process all markers together
      if (mergedMarkerList.length > 0) {
        const allItems: string[] = [];
        let lastProcessedPos = 0;
        
        // Add any text before first marker (intro text)
        if (mergedMarkerList[0].pos > lastProcessedPos) {
          const textBefore = cleanedText.substring(lastProcessedPos, mergedMarkerList[0].pos).trim();
          if (textBefore.length > 0) {
            allItems.push(textBefore);
          }
        }
        
        // Split at each marker in the merged list
        for (let i = 0; i < mergedMarkerList.length; i++) {
          const start = mergedMarkerList[i].pos;
          // Determine end: next marker or end of text
          const end = i < mergedMarkerList.length - 1 
            ? mergedMarkerList[i + 1].pos 
            : cleanedText.length;
          
          const itemText = cleanedText.substring(start, end).trim();
          
          // Include all items, even short ones
          if (itemText.length > 0) {
            allItems.push(itemText);
          }
        }
        
        // Join all items with paragraph tags
        return allItems.map(item => `<p>${item}</p>`).join('');
      }
      
      // Process each valid group independently to avoid mixing separate lists
      const allItems: string[] = [];
      let lastProcessedPos = 0;
      
      for (let groupIndex = 0; groupIndex < validGroups.length; groupIndex++) {
        const group = validGroups[groupIndex];
        const isLastGroup = groupIndex === validGroups.length - 1;
        
        // Add any text before this group (intro or separator text)
        if (group[0].pos > lastProcessedPos) {
          const textBefore = cleanedText.substring(lastProcessedPos, group[0].pos).trim();
          if (textBefore.length > 5) {
            allItems.push(textBefore);
          }
        }
        
        // Split at each marker in this group
        for (let i = 0; i < group.length; i++) {
          const start = group[i].pos;
          // Determine end: next marker in group, or start of next group, or end of text
          let end: number;
          if (i < group.length - 1) {
            end = group[i + 1].pos;
          } else if (!isLastGroup && validGroups[groupIndex + 1]) {
            end = validGroups[groupIndex + 1][0].pos;
          } else {
            end = cleanedText.length;
          }
          
          const itemText = cleanedText.substring(start, end).trim();
          
          // Include all items, even short ones like "I. H" or "IV. N"
          // Only filter out completely empty items
          if (itemText.length > 0) {
            allItems.push(itemText);
          }
        }
        
        // Track where we processed up to (end of last marker in this group)
        if (group.length > 0) {
          // Find where this item actually ends (before next group or end of text)
          if (!isLastGroup && validGroups[groupIndex + 1]) {
            lastProcessedPos = validGroups[groupIndex + 1][0].pos;
          } else {
            // For last group, process to end of text
            lastProcessedPos = cleanedText.length;
          }
        }
      }
      
      // Need at least 2 items to format as paragraphs
      if (allItems.length >= 2) {
        return allItems.map(item => `<p>${item}</p>`).join('\n');
      }
    }
  }
  
  // If no list pattern found, check for explicit newlines or double line breaks
  const paragraphs = cleanedText.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 0);
  if (paragraphs.length <= 1) {
    return `<p>${cleanedText}</p>`;
  }
  return paragraphs.map(p => `<p>${p}</p>`).join('\n');
};

// ============================================================================

// ============================================================================
// PROGRESSIVE RENDERING SETTINGS
// ============================================================================

/** Rows rendered on the first paint - roughly a screenful. */
const FIRST_PAINT_ROWS = 60;
/** Rows appended per idle chunk until the whole table is on screen. */
const ROWS_PER_CHUNK = 150;
/**
 * A page of this many rows or fewer is mounted in one go. Easing it in would
 * only add a visible two-step flicker for no gain - pagination already keeps
 * the commit small. Bigger pages (the "All" option on a large file) still fill
 * progressively so they never block.
 */
const PROGRESSIVE_THRESHOLD = 250;
/** Shared constant so non-edited rows keep an identical prop and skip re-rendering. */
const EMPTY_EDIT_VALUE = '';

/**
 * Whether cells flagged empty still get a `<td>`.
 *
 * This was a useState whose setter was never called, so it has always been
 * false. Kept as an explicit constant rather than fake state.
 *
 * NOTE: at `false`, an empty cell renders no `<td>` at all, which shifts every
 * later column in that row to the left. Harmless while empty cells only ever
 * trail the row (true for the current data), but a file with a gap mid-row
 * would display misaligned. Flip this to `true` if that ever happens.
 */
const SHOW_ALL_COLUMNS = false;

// ============================================================================
// PAGINATION SETTINGS
// ============================================================================

/** Selectable page sizes. */
const PAGE_SIZE_OPTIONS = [50, 100, 250, 500];
/** Sentinel for "show every row on one page". */
const ALL_ROWS = -1;
const DEFAULT_PAGE_SIZE = 100;
/** Remembers the choice between sessions; per browser, never sent anywhere. */
const PAGE_SIZE_STORAGE_KEY = 'excel-processor:table-page-size';

// ============================================================================
// CELL HELPERS
// These are pure functions of their arguments, so they live at module scope:
// defining them inside the component rebuilt them on every single render.
// ============================================================================

const getCellContent = (cell: CellData | null, viewMode: 'original' | 'cleaned') => {
  if (!cell) return '';
  return viewMode === 'original' ? cell.original : cell.cleaned;
};

const getCellMetadata = (cell: CellData | null) => {
  if (!cell) return [];
  const metadata = [];

  if (cell.hasHtml) metadata.push({ type: 'html', label: 'HTML', color: 'bg-orange-100 text-orange-800' });
  if (cell.hasEntities) metadata.push({ type: 'entities', label: 'Entities', color: 'bg-yellow-100 text-yellow-800' });
  if (cell.hasImages) metadata.push({ type: 'images', label: 'Images', color: 'bg-blue-100 text-blue-800' });
  if (cell.isEmpty) metadata.push({ type: 'empty', label: 'Empty', color: 'bg-gray-100 text-gray-800' });
  if (cell.paragraphCount > 1) metadata.push({ type: 'paragraphs', label: `${cell.paragraphCount} paragraphs`, color: 'bg-purple-100 text-purple-800' });

  return metadata;
};

const getCellClass = (colIndex: number, isCode: boolean, isCorrect: boolean, isWrong: boolean) => {
  let cellClass = "relative group";

  // Set width based on column type
  if (colIndex === 0) {
    cellClass += " min-w-20 max-w-28";
  } else if (colIndex === 1) {
    cellClass += " min-w-24 max-w-32";
  } else if (colIndex === 2) {
    cellClass += " min-w-72";
  } else if (isCodeColumn(colIndex)) {
    cellClass += " min-w-20 max-w-24";
  } else {
    cellClass += " min-w-48";
  }

  // Add code-specific styling
  if (isCode) {
    if (isCorrect) {
      cellClass += " bg-green-100 border-l-4 border-green-500";
    } else if (isWrong) {
      cellClass += " bg-red-100 border-l-4 border-red-500";
    } else {
      cellClass += " bg-gray-100 border-l-4 border-gray-300";
    }
  }

  return cellClass;
};

const isCorrectAnswer = (cell: CellData | null) => {
  if (!cell || cell.isEmpty) return false;
  const value = cell.cleaned.trim();
  return value === '1' || value === '1.0' || value === '1.00';
};

const isWrongAnswer = (cell: CellData | null) => {
  if (!cell || cell.isEmpty) return false;
  const value = cell.cleaned.trim();
  return value === '0' || value === '0.0' || value === '0.00';
};

/** " (also: az 3, en 1)" - what the other image languages were, if any. */
function languageBreakdown(stats: Record<string, unknown>): string {
  const totals = (stats.languageTotals as Record<string, number>) || {};
  const target = stats.language as string;
  const others = Object.entries(totals)
    .filter(([code]) => code !== target && code !== 'none')
    .map(([code, n]) => `${code} ${n}`);
  return others.length ? ` (also: ${others.join(', ')})` : '';
}

/**
 * Renders the pictures held in a cell, as thumbnails.
 *
 * Images live in the cell's `original` HTML as base64 data URLs. They are shown
 * small and capped in height so a hundred-row page stays manageable; a click
 * opens the full-size picture in a new tab. A translated image is marked, so a
 * redrawn one can be told from an untouched one at a glance.
 */
function CellImages({ cell }: { cell: CellData }) {
  const images = useMemo(() => {
    const out: Array<{ src: string; translated: boolean }> = [];
    for (const tag of extractImageTags(cell.original)) {
      const src = tag.match(/src\s*=\s*"(data:image\/[^"]+)"/i)?.[1];
      if (src) out.push({ src, translated: tag.includes('data-translated') });
    }
    if (out.length === 0 && cell.imageData?.startsWith('data:image')) {
      out.push({ src: cell.imageData, translated: false });
    }
    return out;
  }, [cell.original, cell.imageData]);

  if (images.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {images.map((image, index) => (
        <a
          key={index}
          href={image.src}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          title={image.translated ? 'Translated image - click to open full size' : 'Click to open full size'}
          className={cn(
            'relative block rounded border bg-white p-1 hover:ring-2 hover:ring-blue-400 transition',
            image.translated ? 'border-rose-400' : 'border-gray-200'
          )}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={image.src}
            alt={image.translated ? 'Translated image from the question' : 'Image from the question'}
            loading="lazy"
            className="block max-h-24 w-auto max-w-[220px] object-contain"
          />
          {image.translated && (
            <span className="absolute -top-1.5 -right-1.5 rounded-full bg-rose-500 px-1.5 text-[9px] font-bold text-white">
              AZ
            </span>
          )}
        </a>
      ))}
    </div>
  );
}

/** One "1,234 questions" style figure in the summary line. */
function Stat({ label, value, tone }: { label: string; value: number; tone?: 'violet' }) {
  return (
    <span className={cn('whitespace-nowrap', tone === 'violet' ? 'text-violet-600' : 'text-gray-500')}>
      <span className={cn('font-semibold', tone === 'violet' ? 'text-violet-700' : 'text-gray-700')}>
        {value.toLocaleString()}
      </span>{' '}
      {label}
    </span>
  );
}

// ============================================================================
// ROW COMPONENT
// ============================================================================

interface DataTableRowProps {
  row: (CellData | null)[];
  rowIndex: number;
  viewMode: 'original' | 'cleaned';
  showAllColumns: boolean;
  editable: boolean;
  showMetadata: boolean;
  /** Column currently being edited in THIS row, or null. */
  editingCol: number | null;
  editValue: string;
  onEditValueChange: (value: string) => void;
  onEdit: (row: number, col: number) => void;
  onDelete: (row: number, col: number) => void;
  onSave: () => void;
  onCancel: () => void;
}

/**
 * One table row, memoised.
 *
 * Without this, editing a single cell (or appending the next chunk of rows)
 * re-rendered every cell in the table. `editingCol` is passed instead of the
 * whole editing-cell object so that rows which are not being edited keep their
 * previous props and skip re-rendering entirely.
 */
const DataTableRow = React.memo(function DataTableRow({
  row,
  rowIndex,
  viewMode,
  showAllColumns,
  editable,
  showMetadata,
  editingCol,
  editValue,
  onEditValueChange,
  onEdit,
  onDelete,
  onSave,
  onCancel
}: DataTableRowProps) {
  return (
    <TableRow
      className={cn(
        "transition-colors hover:bg-blue-50/60",
        // Zebra striping: with 15 wide columns it is easy to lose your place
        // while scrolling horizontally.
        rowIndex % 2 === 1 && "bg-slate-50/60"
      )}
    >
      <TableCell className="font-medium text-slate-500 bg-slate-100/80 sticky left-0 z-10 border-r border-gray-200 text-center tabular-nums">
        {rowIndex + 1}
      </TableCell>
      {row.map((cell, colIndex) => {
        const isEmpty = !cell || cell.isEmpty;
        const isEditing = editingCol === colIndex;

        if (isEmpty && !showAllColumns) return null;

        const isCode = isCodeColumn(colIndex);
        const isCorrect = isCorrectAnswer(cell);
        const isWrong = isWrongAnswer(cell);

        const cellClass = getCellClass(colIndex, isCode, isCorrect, isWrong);

        return (
          <TableCell key={colIndex} className={cellClass}>
            {isEditing ? (
              <div className="flex items-center gap-2">
                <Input
                  value={editValue}
                  onChange={(e) => onEditValueChange(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter commits, Escape backs out - the keys people expect
                    // from an inline edit.
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      onSave();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      onCancel();
                    }
                  }}
                  className="flex-1"
                  autoFocus
                  aria-label={`Edit row ${rowIndex + 1}, column ${colIndex}`}
                />
                <Button size="sm" onClick={onSave} title="Save (Enter)" aria-label="Save cell">
                  <CheckCircle className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="outline" onClick={onCancel} title="Cancel (Esc)" aria-label="Cancel edit">
                  <AlertCircle className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    {isCode ? (
                      <div className="flex items-center gap-2">
                        {isCorrect && <Check className="h-4 w-4 text-green-600" />}
                        {isWrong && <X className="h-4 w-4 text-red-600" />}
                        {!isCorrect && !isWrong && <HelpCircle className="h-4 w-4 text-gray-400" />}
                        <p className={cn(
                          "text-sm font-semibold",
                          isCorrect ? "text-green-800" : isWrong ? "text-red-800" : "text-gray-600"
                        )}>
                          {getCellContent(cell, viewMode)}
                        </p>
                      </div>
                    ) : (
                      <p className={cn(
                        "text-sm break-words",
                        isEmpty ? "text-gray-400 italic" : "text-gray-900"
                      )}>
                        {isEmpty ? 'Empty' : getCellContent(cell, viewMode)}
                      </p>
                    )}

                    {/* The pictures themselves. The table used to show only an
                        "Images" badge, which made it impossible to check the
                        result of an image translation without exporting first. */}
                    {cell?.hasImages && <CellImages cell={cell} />}
                  </div>

                  {editable && !isEmpty && colIndex > 1 && (
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onEdit(rowIndex, colIndex)}
                        title="Edit cell"
                        aria-label={`Edit row ${rowIndex + 1}, column ${colIndex}`}
                        className="hover:bg-blue-100 hover:text-blue-700"
                      >
                        <Edit2 className="h-3 w-3" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onDelete(rowIndex, colIndex)}
                        title="Clear cell"
                        aria-label={`Clear row ${rowIndex + 1}, column ${colIndex}`}
                        className="hover:bg-red-100 hover:text-red-700"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  )}
                </div>

                {showMetadata && cell && (
                  <div className="flex flex-wrap gap-1">
                    {getCellMetadata(cell).map((meta, index) => (
                      <Badge
                        key={index}
                        variant="secondary"
                        className={cn("text-xs", meta.color)}
                      >
                        {meta.type === 'html' && <Code className="h-3 w-3 mr-1" />}
                        {meta.type === 'images' && <ImageIcon className="h-3 w-3 mr-1" />}
                        {meta.label}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            )}
          </TableCell>
        );
      })}
    </TableRow>
  );
});

interface DataTableProps {
  data: CellData[];
  /** Stored file id - needed by the image-question filter action. */
  fileId?: string;
  /** Display name shown in the file list — used for export download names. */
  fileName?: string;
  /** Called with the new file after an action rewrites the open one. */
  onFileReplaced?: (file: FileData) => void;
  /** Model used for the AI image analysis, from the AI Model panel. */
  selectedModel?: string;
  onCellEdit?: (rowIndex: number, colIndex: number, value: string) => void;
  onCellDelete?: (rowIndex: number, colIndex: number) => void;
  editable?: boolean;
  showMetadata?: boolean;
}

export function DataTable({ 
  data, 
  fileId,
  fileName,
  onFileReplaced,
  selectedModel = 'gpt-5-nano',
  onCellEdit, 
  onCellDelete, 
  editable = true,
  showMetadata = true
}: DataTableProps) {
  const [editingCell, setEditingCell] = useState<{ row: number; col: number } | null>(null);
  const [editValue, setEditValue] = useState('');
  const [viewMode, setViewMode] = useState<'original' | 'cleaned'>('cleaned');

  // Convert flat cell data to 2D array for table display
  const tableData = useMemo(() => {
    if (!data || data.length === 0) {
      return [];
    }

    // Find max row and column indices in a single pass.
    // Math.max(...array) was used here before: it builds two throwaway arrays and
    // passes every cell as a function argument, which blows the call stack once a
    // file gets big enough.
    let maxRow = 0;
    let maxCol = 0;
    for (const cell of data) {
      if (cell.rowIndex > maxRow) maxRow = cell.rowIndex;
      if (cell.colIndex > maxCol) maxCol = cell.colIndex;
    }

    // Create 2D array
    const rows: (CellData | null)[][] = [];
    for (let i = 0; i <= maxRow; i++) {
      rows[i] = new Array(maxCol + 1).fill(null);
    }

    // Fill with actual data
    data.forEach(cell => {
      rows[cell.rowIndex][cell.colIndex] = cell;
    });

    return rows;
  }, [data]);

  // --------------------------------------------------------------------------
  // PAGINATION
  //
  // The cost of this table is the number of cells in the DOM, and it grows with
  // the file: 1,000 rows x 15 columns is 15,000 cells, each with nested markup.
  // That is what makes the first paint slow and scrolling stutter. Showing one
  // page at a time keeps the DOM a constant size no matter how big the file is.
  //
  // Both exports read `tableData`, not the current page, so a download always
  // contains the whole file.
  // --------------------------------------------------------------------------
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [page, setPage] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Restore the saved preference after mount. Reading localStorage during the
  // first render would differ from the server-rendered HTML and break hydration.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(PAGE_SIZE_STORAGE_KEY);
      if (saved === null) return;
      const parsed = parseInt(saved, 10);
      if (parsed === ALL_ROWS || PAGE_SIZE_OPTIONS.includes(parsed)) {
        setPageSize(parsed);
      }
    } catch {
      // Storage can be unavailable (private window, blocked cookies). The
      // default is perfectly usable, so there is nothing to handle.
    }
  }, []);

  const rowsPerPage = pageSize === ALL_ROWS ? Math.max(tableData.length, 1) : pageSize;
  const pageCount = Math.max(1, Math.ceil(tableData.length / rowsPerPage));
  // Clamp rather than store a corrected page, so loading a smaller file cannot
  // strand the view on a page that no longer exists.
  const currentPage = Math.min(page, pageCount - 1);
  const pageStart = currentPage * rowsPerPage;
  const pageEnd = Math.min(pageStart + rowsPerPage, tableData.length);

  const pageRows = useMemo(
    () => tableData.slice(pageStart, pageEnd),
    [tableData, pageStart, pageEnd]
  );

  // Opening a different file starts again at the first page.
  useEffect(() => {
    setPage(0);
  }, [tableData]);

  const goToPage = useCallback((next: number) => {
    setPage(next);
    // Land at the top of the new page instead of wherever the last one was
    // scrolled to.
    scrollRef.current?.scrollTo({ top: 0, left: scrollRef.current.scrollLeft });
  }, []);

  const handlePageSizeChange = useCallback((next: number) => {
    setPageSize(next);
    setPage(0);
    scrollRef.current?.scrollTo({ top: 0, left: 0 });
    try {
      window.localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(next));
    } catch {
      // Preference simply will not persist; the table still works.
    }
  }, []);

  // PERFORMANCE: a large page still paints a screenful first and fills the rest
  // in idle chunks, so it never blocks on one big commit. A normal-sized page
  // is rendered whole immediately.
  const initialRowCount = (rows: unknown[]) =>
    rows.length <= PROGRESSIVE_THRESHOLD ? rows.length : FIRST_PAINT_ROWS;

  const [visibleRowCount, setVisibleRowCount] = useState(FIRST_PAINT_ROWS);

  useEffect(() => {
    setVisibleRowCount(initialRowCount(pageRows));
  }, [pageRows]);

  useEffect(() => {
    if (visibleRowCount >= pageRows.length) return;

    let cancelled = false;
    const grow = () => {
      if (!cancelled) {
        setVisibleRowCount(count => Math.min(count + ROWS_PER_CHUNK, pageRows.length));
      }
    };

    const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
    if (typeof idle === 'function') {
      const handle = idle(grow, { timeout: 250 });
      return () => {
        cancelled = true;
        (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback?.(handle);
      };
    }

    const handle = window.setTimeout(grow, 16);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [visibleRowCount, pageRows.length]);

  const visibleRows = useMemo(
    () => (visibleRowCount >= pageRows.length ? pageRows : pageRows.slice(0, visibleRowCount)),
    [pageRows, visibleRowCount]
  );

  const isFillingRows = visibleRowCount < pageRows.length;

  // Keep the latest edit state in refs so the row callbacks below can stay
  // referentially stable. Unstable callbacks would defeat the row memoisation
  // and re-render the whole table on every keystroke.
  const editingCellRef = useRef(editingCell);
  editingCellRef.current = editingCell;
  const editValueRef = useRef(editValue);
  editValueRef.current = editValue;

  const handleEdit = useCallback((row: number, col: number) => {
    const cell = tableData[row]?.[col];
    if (cell) {
      setEditingCell({ row, col });
      setEditValue(viewMode === 'original' ? cell.original : cell.cleaned);
    }
  }, [tableData, viewMode]);

  const handleSave = useCallback(() => {
    const editing = editingCellRef.current;
    if (editing && onCellEdit) {
      onCellEdit(editing.row, editing.col, editValueRef.current);
    }
    setEditingCell(null);
    setEditValue('');
  }, [onCellEdit]);

  const handleCancel = useCallback(() => {
    setEditingCell(null);
    setEditValue('');
  }, []);

  const handleDelete = useCallback((row: number, col: number) => {
    if (onCellDelete) {
      onCellDelete(row, col);
    }
  }, [onCellDelete]);


  /**
   * Long digit-only values (question IDs) must stay text. Excel / SheetJS otherwise
   * turn them into numbers → scientific notation (2.50411E+17) and lose digits.
   */
  const looksLikeNumericId = (value: string): boolean => /^\d{12,}$/.test(value.trim());

  /**
   * Download name from the file's nice title in the app
   * (e.g. "Olimpiada_new_phase_HIS.xlsx (az)" → "Olimpiada_new_phase_HIS.xlsx (az).csv").
   */
  const buildExportFileName = (extension: string): string => {
    const date = new Date().toISOString().split('T')[0];
    const fallback = `data-export-${date}`;
    const raw = (fileName || '').trim() || fallback;

    // Strip a trailing extension so we do not get ".xlsx.csv"
    const withoutExt = raw.replace(/\.(xlsx|xls|csv|html|htm)$/i, '');
    const safe = withoutExt
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);

    return `${safe || fallback}.${extension}`;
  };

  const handleExportExcelWithHTML = () => {
    if (!tableData || tableData.length === 0) return;

    // Excel cells cannot hold more than 32,767 characters. Real cells with
    // embedded base64 images blow past that and XLSX.writeFile throws.
    const EXCEL_MAX_CELL = 32767;
    const truncateNote = '\n…[truncated for Excel 32767-char limit]';

    const shouldFormatColumn = (colIndex: number, cellValue: string): boolean => {
      if (colIndex === 0 || colIndex === 1) return false;
      if (cellValue === '0' || cellValue === '1') return false;
      if (!cellValue || !cellValue.trim()) return false;
      if (cellValue.trim().toLowerCase() === 'null') return false;
      return true;
    };

    const fitExcelCell = (text: string): { value: string; truncated: boolean } => {
      if (text.length <= EXCEL_MAX_CELL) return { value: text, truncated: false };
      const budget = EXCEL_MAX_CELL - truncateNote.length;
      return { value: text.slice(0, Math.max(0, budget)) + truncateNote, truncated: true };
    };

    const workbook = XLSX.utils.book_new();
    let truncatedCells = 0;
    let imagesOmitted = 0;

    const worksheetData = tableData.map((row) =>
      row.map((cell, colIndex) => {
        if (!cell) return '';

        const { text, images, html } = buildExportCellContent(cell, (raw) => {
          let formatted = formatAsParagraphs(raw, colIndex, shouldFormatColumn);
          if (cell.original && cell.original.includes('<span')) {
            formatted = formatted.replace(
              /<p>/g,
              '<p style="font-family: Cambria, serif;">'
            );
          }
          return formatted;
        });

        // Prefer full HTML like the HTML export (real <img> tags, not [IMAGE]).
        // If that exceeds Excel's limit, keep the text and note that images
        // need CSV/HTML export — never replace pictures with a fake [IMAGE] stub.
        let content = html;
        if (content.length > EXCEL_MAX_CELL && images.length > 0) {
          imagesOmitted += images.length;
          const note = `\n[${images.length} image(s) omitted — use Export CSV or Export to HTML for full images]`;
          content = text ? `${text}${note}` : note.trim();
        }

        const fitted = fitExcelCell(content);
        if (fitted.truncated) truncatedCells++;
        return fitted.value;
      })
    );

    const worksheet = XLSX.utils.aoa_to_sheet(worksheetData);
    const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1');

    for (let row = range.s.r; row <= range.e.r; row++) {
      for (let col = range.s.c; col <= range.e.c; col++) {
        const cellAddress = XLSX.utils.encode_cell({ r: row, c: col });
        const cell = worksheet[cellAddress];
        if (!cell) continue;

        // Restore text from our source array — aoa_to_sheet may have already
        // converted long digit IDs into lossy numbers.
        const raw = String(worksheetData[row]?.[col] ?? '');
        const forceText = col === 0 || looksLikeNumericId(raw);

        cell.t = 's';
        cell.v = forceText ? raw.trim() : raw;
        if (forceText) {
          cell.z = '@'; // Excel "Text" format
        }
        cell.s = {
          alignment: {
            wrapText: true,
            vertical: 'top',
            horizontal: 'left'
          },
          fill: { fgColor: { rgb: 'FFFFFF' } }
        };
      }
    }

    const maxWidths = new Array(range.e.c + 1).fill(0);
    for (let row = range.s.r; row <= range.e.r; row++) {
      for (let col = range.s.c; col <= range.e.c; col++) {
        const cellAddress = XLSX.utils.encode_cell({ r: row, c: col });
        const cell = worksheet[cellAddress];
        if (cell && cell.v) {
          const content = String(cell.v);
          maxWidths[col] = Math.max(maxWidths[col], Math.min(content.length, 100));
        }
      }
    }
    worksheet['!cols'] = maxWidths.map((w) => ({ wch: Math.min(Math.max(w, 15), 100) }));

    XLSX.utils.book_append_sheet(workbook, worksheet, 'Data');
    XLSX.writeFile(workbook, buildExportFileName('xlsx'));

    const warnings: string[] = [];
    if (truncatedCells > 0) {
      warnings.push(
        `${truncatedCells} cell(s) were longer than Excel's 32,767-character limit and were truncated.`
      );
    }
    if (imagesOmitted > 0) {
      warnings.push(
        `${imagesOmitted} image(s) were omitted because they did not fit in an Excel cell.\nUse "Export CSV" or "Export to HTML" for full images (same as import).`
      );
    }
    if (warnings.length > 0) {
      alert(`Excel export finished with notes:\n\n${warnings.join('\n\n')}`);
    }
  };

  /**
   * CSV export — same cell content as HTML export: translated text + real
   * `<img src="data:image/...">` tags (no `[IMAGE]` stubs). May be large.
   */
  const handleExportCSV = () => {
    if (!tableData || tableData.length === 0) return;

    const escapeCsv = (value: string): string => {
      const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      if (/[",\n]/.test(normalized)) {
        return `"${normalized.replace(/"/g, '""')}"`;
      }
      return normalized;
    };

    /**
     * When Excel opens a CSV it re-parses digit-only cells as numbers.
     * `="250411…"` forces Excel to keep the full ID as text.
     */
    const csvSafeValue = (col: number, text: string): string => {
      const trimmed = text.trim();
      if (col === 0 || looksLikeNumericId(trimmed)) {
        return escapeCsv(`="${trimmed}"`);
      }
      return escapeCsv(text);
    };

    const colCount = Math.max(...tableData.map((row) => row.length), 0);
    const header = Array.from({ length: colCount }, (_, i) => `Col_${i + 1}`);

    const lines: string[] = [header.map(escapeCsv).join(',')];

    for (const row of tableData) {
      const values: string[] = [];
      for (let col = 0; col < colCount; col++) {
        const cell = row[col];
        const content = cell ? buildExportCellContent(cell).html : '';
        values.push(csvSafeValue(col, content));
      }
      lines.push(values.join(','));
    }

    // BOM so Excel opens UTF-8 (Azerbaijani / Cyrillic) correctly
    const csv = '\uFEFF' + lines.join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = buildExportFileName('csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleExportHTML = () => {
    if (!tableData || tableData.length === 0) return;

    // Generate HTML with full formatting
    let htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Exported Data</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            margin: 20px;
            background-color: #f5f5f5;
            line-height: 1.6;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
            background-color: white;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 20px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        th, td {
            border: 1px solid #ddd;
            padding: 15px;
            text-align: left;
            vertical-align: top;
        }
        th {
            background-color: #4CAF50;
            color: white;
            font-weight: bold;
            text-transform: uppercase;
            font-size: 0.9em;
            letter-spacing: 0.5px;
        }
        tr:nth-child(even) {
            background-color: #f9f9f9;
        }
        tr:hover {
            background-color: #f5f5f5;
            transition: background-color 0.2s ease;
        }
        .has-html {
            background-color: #fff3cd;
        }
        .has-images {
            padding: 15px;
        }
        .has-images img {
            margin: 10px auto;
            display: inline-block;
        }
        .code-cell {
            background-color: #f8f9fa;
            font-family: 'Courier New', monospace;
            font-weight: bold;
        }
        img {
            max-width: 300px;
            height: auto;
            display: block;
            margin: 8px 0;
            border: 1px solid #ddd;
            border-radius: 4px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .question-cell {
            font-weight: 600;
            color: #2c3e50;
        }
        .para-item {
            margin: 8px 0;
            padding: 6px 0;
            line-height: 1.8;
            color: #333;
        }
        .para-item:first-child {
            margin-top: 0;
            padding-top: 0;
        }
        .para-item:last-child {
            margin-bottom: 0;
            padding-bottom: 0;
        }
        .para-item:not(:last-child) {
            border-bottom: 1px solid #e0e0e0;
        }
        td {
            font-size: 14px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1 style="color: #2c3e50; margin-bottom: 10px;">Exported Excel Data</h1>
        <p style="color: #666; font-size: 0.95em;">Exported on: ${new Date().toLocaleString()}</p>
        <p style="color: #666; font-size: 0.95em; margin-bottom: 20px;"><strong>Features:</strong> Original formatting, HTML content, embedded images, and styling preserved</p>
        <table>
            <thead>
                <tr>
                    ${tableData[0]?.map((_, index) => `<th>Column ${index}</th>`).join('')}
                </tr>
            </thead>
            <tbody>
`;

    // Add table rows with formatting
    for (let i = 0; i < tableData.length; i++) {
      const row = tableData[i];
      htmlContent += '                <tr>\n';
      
      for (let j = 0; j < row.length; j++) {
        const cell = row[j];
        let cellClass = '';

        if (cell) {
          // Same content shape as CSV / Excel: cleaned text + real <img> tags
          const { html: cellContent } = buildExportCellContent(cell, (raw) =>
            formatAsParagraphs(raw)
          );

          if (cell.hasHtml) cellClass += ' has-html';
          if (cell.hasImages || collectExportImageTags(cell).length > 0) {
            cellClass += ' has-images';
          }
          if (isCodeColumn(j)) cellClass += ' code-cell';
          if (j === 2) cellClass += ' question-cell';

          if (
            cellContent &&
            (cellContent.includes(' r.') ||
              cellContent.includes(' n.') ||
              cellContent.includes(' i.'))
          ) {
            console.warn(
              '⚠️ [HTML Export] Writing cellContent with errors to HTML:',
              cellContent.substring(0, 150)
            );
          }

          htmlContent += `                    <td class="${cellClass}">${cellContent}</td>\n`;
        } else {
          htmlContent += `                    <td class="${cellClass}"></td>\n`;
        }
      }
      
      htmlContent += '                </tr>\n';
    }
    
    htmlContent += `
            </tbody>
        </table>
    </div>
</body>
</html>`;

    // Create and download HTML file
    const blob = new Blob([htmlContent], { type: 'text/html' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', buildExportFileName('html'));
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // --------------------------------------------------------------------------
  // IMAGE QUESTIONS
  //
  // Every cell already carries a `hasImages` flag, worked out when the file was
  // uploaded. No AI is involved here - this only scans the questions and drops
  // the ones with no picture anywhere. The export itself is the ordinary HTML
  // export, so the result is the same document with fewer rows.
  // --------------------------------------------------------------------------
  const imageReport = useMemo(() => analyzeImageQuestions(tableData), [tableData]);

  // --------------------------------------------------------------------------
  // TABLE ACTIONS
  //
  // Both actions rewrite the open file into a new stored file. They report
  // through one dialog rather than the browser's native confirm()/alert(), so
  // the user can see the plan first, watch progress, and read the outcome
  // without the page freezing.
  // --------------------------------------------------------------------------
  type ActionKind = 'images' | 'imageText' | 'translateImages';

  const [action, setAction] = useState<ActionKind | null>(null);
  const [actionState, setActionState] = useState<ActionDialogState>('confirm');
  const [actionProgress, setActionProgress] = useState<ActionProgress | undefined>();
  const [actionMessage, setActionMessage] = useState<ReactNode>(null);

  /**
   * Which language the image text must be in to count.
   *
   * Words in a language you are not translating into are no more useful than no
   * words at all, so this narrows the result further. Russian by default, since
   * that is what these papers are written in.
   */
  const [imageLanguage, setImageLanguage] = useState<ImageTextLanguage | 'any'>('ru');

  const closeAction = () => {
    if (actionState === 'running') return;
    setAction(null);
    setActionProgress(undefined);
    setActionMessage(null);
  };

  const openAction = (kind: ActionKind) => {
    setAction(kind);
    setActionState('confirm');
    setActionProgress(undefined);
    setActionMessage(null);
  };

  const failAction = (error: unknown) => {
    setActionState('error');
    setActionProgress(undefined);
    setActionMessage(error instanceof Error ? error.message : String(error));
  };

  /** Nothing to do when every question already has an image. */
  const removableCount = imageReport.stats.totalQuestions - imageReport.stats.withImages;

  /** Step 1: drop the questions that have no picture at all. No model involved. */
  const runKeepImageQuestions = async () => {
    if (!fileId) return;
    setActionState('running');
    setActionProgress({ done: 0, total: 0, label: 'Filtering questions…' });

    try {
      const response = await fetch('/api/files/images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId })
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.success) {
        throw new Error(result?.error || `Request failed: ${response.statusText}`);
      }

      const s = result.stats;
      setActionState('done');
      setActionProgress(undefined);
      setActionMessage(
        <>
          <p>
            Kept <strong>{s.withImages.toLocaleString()}</strong> question(s) with images and removed{' '}
            <strong>{(s.totalQuestions - s.withImages).toLocaleString()}</strong> without.
          </p>
          <ul className="list-disc pl-5 text-gray-600">
            <li>{s.questionOnly} image in the question</li>
            <li>{s.variantsOnly} image in the variants</li>
            <li>{s.both} image in both</li>
            <li>{s.totalImages} image(s) in total</li>
          </ul>
        </>
      );
      onFileReplaced?.(result.data);
    } catch (error) {
      console.error('Image filter failed:', error);
      failAction(error);
    }
  };

  // --- Step 3: redraw the images with translated text -----------------------
  const [imgTrLanguage, setImgTrLanguage] = useState('Azerbaijani');
  const [imgTrModel, setImgTrModel] = useState(DEFAULT_IMAGE_TRANSLATE_MODEL);
  /** 0 = every image. A small number lets the quality be checked cheaply first. */
  const [imgTrLimit, setImgTrLimit] = useState(3);
  const [imgTrSpent, setImgTrSpent] = useState(0);

  const imgTrModelInfo =
    IMAGE_TRANSLATE_MODELS.find((m) => m.id === imgTrModel) || IMAGE_TRANSLATE_MODELS[0];
  /** -1 means "only what is already paid for", so it costs nothing. */
  const imgTrCachedOnly = imgTrLimit === -1;
  const imgTrCount = imgTrCachedOnly
    ? 0
    : imgTrLimit > 0
      ? Math.min(imgTrLimit, imageReport.stats.totalImages)
      : imageReport.stats.totalImages;
  const imgTrEstimate = imgTrCount * imgTrModelInfo.costPerImage;

  /**
   * Redraws each picture with its words translated.
   *
   * By far the most expensive action in the app, so the dialog shows an
   * estimate before anything runs and the spend as it happens.
   */
  const runTranslateImages = async () => {
    if (!fileId) return;
    setActionState('running');
    setImgTrSpent(0);
    setActionProgress({ done: 0, total: 0, label: 'Collecting images…' });

    try {
      const response = await fetch('/api/files/translate-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileId,
          targetLanguage: imgTrLanguage,
          model: imgTrModel,
          limit: imgTrLimit
        })
      });

      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        throw new Error(failure?.error || `Request failed: ${response.statusText}`);
      }
      if (!response.body) throw new Error('This browser cannot read a streamed response.');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;

      const handle = (event: Record<string, unknown>) => {
        if (event.type === 'start') {
          const total = Number(event.total) || 0;
          const cached = Number(event.cached) || 0;
          setActionProgress({
            done: cached,
            total,
            label: `Redrawing ${total} image(s) with ${imgTrModelInfo.name}`
          });
        } else if (event.type === 'progress') {
          const done = Number(event.done) || 0;
          const total = Number(event.total) || 0;
          setImgTrSpent(Number(event.spent) || 0);
          setActionProgress({
            done,
            total,
            label: `Image ${Math.min(done + 1, total)} of ${total} · ${(Number(event.spent) || 0).toFixed(2)} spent`
          });
        } else if (event.type === 'done') {
          finished = true;
          const s = event.stats as Record<string, number | string>;
          setActionState('done');
          setActionProgress(undefined);
          setActionMessage(
            <>
              <p>
                Redrew <strong>{Number(s.translated).toLocaleString()}</strong> image(s) in{' '}
                {String(s.targetLanguage)}, updating{' '}
                <strong>{Number(s.cellsChanged).toLocaleString()}</strong> cell(s).
              </p>
              <ul className="list-disc pl-5 text-gray-600">
                <li>{Number(s.fromCache)} served from cache (free)</li>
                {Number(s.skipped) > 0 && <li>{Number(s.skipped)} image(s) not attempted (limit)</li>}
                {Number(s.failed) > 0 && <li className="text-red-600">{Number(s.failed)} failed</li>}
              </ul>
              <p className="font-semibold">
                Spent this run: ${Number(s.spent).toFixed(2)}
              </p>
              <p className="text-gray-500 text-xs">
                The originals are untouched and still in Files. Translated pictures are pinned to
                their original display size, so nothing in the layout moves.
              </p>
            </>
          );
          onFileReplaced?.(event.data as FileData);
        } else if (event.type === 'error') {
          finished = true;
          failAction(new Error(String(event.error)));
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) if (line.trim()) handle(JSON.parse(line));
      }
      if (buffer.trim()) handle(JSON.parse(buffer));
      if (!finished) throw new Error('The run ended without a result.');
    } catch (error) {
      console.error('Image translation failed:', error);
      failAction(error);
    }
  };

  /**
   * Step 2: ask a vision model which images actually contain words.
   *
   * The response is a stream of NDJSON events, so the dialog can show real
   * per-image progress instead of an indefinite spinner.
   */
  const runKeepImagesWithText = async () => {
    if (!fileId) return;
    setActionState('running');
    setActionProgress({ done: 0, total: 0, label: 'Collecting images…' });

    try {
      const response = await fetch('/api/files/image-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId, model: selectedModel, language: imageLanguage })
      });

      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        throw new Error(failure?.error || `Request failed: ${response.statusText}`);
      }
      if (!response.body) throw new Error('This browser cannot read a streamed response.');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;

      const handle = (event: Record<string, unknown>) => {
        if (event.type === 'start') {
          const total = Number(event.total) || 0;
          const cached = Number(event.cached) || 0;
          setActionProgress({
            done: cached,
            total,
            label: `Reading ${total.toLocaleString()} image(s) with ${selectedModel}`
          });
        } else if (event.type === 'progress') {
          const done = Number(event.done) || 0;
          const total = Number(event.total) || 0;
          setActionProgress({
            done,
            total,
            label: `Reading image ${Math.min(done + 1, total).toLocaleString()} of ${total.toLocaleString()}`
          });
        } else if (event.type === 'done') {
          finished = true;
          const s = event.stats as Record<string, number>;
          setActionState('done');
          setActionProgress(undefined);
          setActionMessage(
            <>
              <p>
                Kept <strong>{s.questionsKept.toLocaleString()}</strong> of{' '}
                {s.questionsWithImages.toLocaleString()} image question(s), removing{' '}
                <strong>{s.questionsRemoved.toLocaleString()}</strong> whose pictures had nothing
                to translate.
              </p>
              <ul className="list-disc pl-5 text-gray-600">
                <li>{s.withWords} image(s) contain words</li>
                {imageLanguage !== 'any' && (
                  <li>
                    <strong>{s.inTargetLanguage}</strong> of those are in{' '}
                    {IMAGE_TEXT_LANGUAGES.find((l) => l.code === imageLanguage)?.name ?? imageLanguage}
                    {languageBreakdown(event.stats as Record<string, unknown>)}
                  </li>
                )}
                <li>{s.numericOnly} image(s) are numbers or symbols only</li>
                <li>{s.noText} image(s) have no text</li>
              </ul>
              <p className="text-gray-500 text-xs">
                {s.imagesAnalyzed} analysed, {s.imagesFromCache} from cache
                {s.imagesFailed ? `, ${s.imagesFailed} unreadable` : ''}.
              </p>
            </>
          );
          onFileReplaced?.(event.data as FileData);
        } else if (event.type === 'error') {
          finished = true;
          failAction(new Error(String(event.error)));
        }
      };

      // Newline-delimited JSON: a chunk may split a line, so keep the remainder.
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) handle(JSON.parse(line));
        }
      }
      if (buffer.trim()) handle(JSON.parse(buffer));

      if (!finished) throw new Error('The analysis ended without a result.');
    } catch (error) {
      console.error('Image-text analysis failed:', error);
      failAction(error);
    }
  };



  if (!tableData || tableData.length === 0) {
    return (
      <div className="text-center py-12">
        <FileText className="h-12 w-12 text-gray-400 mx-auto mb-4" />
        <p className="text-gray-600">No data to display</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <style jsx global>{`
        .data-table-scroll {
          scrollbar-width: thin;
          scrollbar-color: #3b82f6 #f1f5f9;
        }
        .data-table-scroll::-webkit-scrollbar {
          width: 12px;
          height: 12px;
        }
        .data-table-scroll::-webkit-scrollbar-track {
          background: #f1f5f9;
          border-radius: 6px;
        }
        .data-table-scroll::-webkit-scrollbar-thumb {
          background: #3b82f6;
          border-radius: 6px;
          border: 2px solid #f1f5f9;
        }
        .data-table-scroll::-webkit-scrollbar-thumb:hover {
          background: #2563eb;
        }
        .data-table-scroll::-webkit-scrollbar-corner {
          background: #f1f5f9;
        }
      `}</style>
      {/* Controls */}
      <div className="space-y-3 p-4 bg-gray-50 rounded-lg">
        {/* Row 1: view mode | actions | exports - kept in separate labelled
            groups so a button that rewrites the file is never mistaken for one
            that just downloads a copy. */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-2">
            <Button
              variant={viewMode === 'cleaned' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setViewMode('cleaned')}
            >
              <CheckCircle className="h-4 w-4 mr-1" />
              Cleaned
            </Button>
            <Button
              variant={viewMode === 'original' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setViewMode('original')}
            >
              <Code className="h-4 w-4 mr-1" />
              Original
            </Button>
          </div>

          {fileId && (
            <div className="flex items-center gap-2 pl-6 border-l border-gray-300">
              <span className="text-[11px] font-bold uppercase tracking-wider text-gray-400">
                Filter file
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => openAction('images')}
                disabled={removableCount === 0}
                title={
                  imageReport.stats.withImages === 0
                    ? 'No question in this file contains an image'
                    : removableCount === 0
                      ? 'Every question here already has an image - nothing to remove'
                      : `Remove the ${removableCount.toLocaleString()} question(s) without images, keeping ${imageReport.stats.withImages.toLocaleString()}`
                }
                className="bg-violet-50 border-violet-300 text-violet-700 hover:bg-violet-100 disabled:opacity-50"
              >
                <ImageIcon className="h-4 w-4 mr-1" />
                Only Images
                {imageReport.stats.withImages > 0 && (
                  <span className="ml-1.5 rounded-full bg-violet-200 px-1.5 text-[11px] font-bold tabular-nums">
                    {imageReport.stats.withImages}
                  </span>
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => openAction('imageText')}
                disabled={imageReport.stats.withImages === 0}
                title={
                  imageReport.stats.withImages === 0
                    ? 'No question in this file contains an image'
                    : `Ask ${selectedModel} to read the ${imageReport.stats.totalImages.toLocaleString()} image(s) and keep only the questions whose pictures contain words`
                }
                className="bg-fuchsia-50 border-fuchsia-300 text-fuchsia-700 hover:bg-fuchsia-100 disabled:opacity-50"
              >
                <ScanText className="h-4 w-4 mr-1" />
                Images With Text
                <span className="ml-1.5 rounded-full bg-fuchsia-200 px-1.5 text-[11px] font-bold">AI</span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => openAction('translateImages')}
                disabled={imageReport.stats.totalImages === 0}
                title={
                  imageReport.stats.totalImages === 0
                    ? 'This file has no images to translate'
                    : `Redraw the ${imageReport.stats.totalImages.toLocaleString()} image(s) with their text translated - this one costs real money`
                }
                className="bg-rose-50 border-rose-300 text-rose-700 hover:bg-rose-100 disabled:opacity-50"
              >
                <Languages className="h-4 w-4 mr-1" />
                Translate Images
                <span className="ml-1.5 rounded-full bg-rose-200 px-1.5 text-[11px] font-bold">$</span>
              </Button>
            </div>
          )}

          <div className="flex items-center gap-2 pl-6 border-l border-gray-300">
            <span className="text-[11px] font-bold uppercase tracking-wider text-gray-400">
              Download
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportCSV}
              title="Export translated text + real &lt;img&gt; tags (same as HTML export; file may be large)"
              className="bg-sky-50 border-sky-300 text-sky-700 hover:bg-sky-100"
            >
              <FileSpreadsheet className="h-4 w-4 mr-1" />
              Export CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportExcelWithHTML}
              title="Export like HTML when images fit. Oversized images are omitted (use CSV/HTML) — never replaced with [IMAGE]."
              className="bg-purple-50 border-purple-300 text-purple-700 hover:bg-purple-100"
            >
              <FileText className="h-4 w-4 mr-1" />
              Excel + HTML
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportHTML}
              title="Export to HTML for web projects"
              className="bg-green-50 border-green-300 text-green-700 hover:bg-green-100"
            >
              <Code className="h-4 w-4 mr-1" />
              Export to HTML
            </Button>
          </div>
        </div>

        {/* Row 2: what this file actually contains, plus the page size. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs border-t border-gray-200 pt-3">
          <label className="flex items-center gap-1.5 text-gray-600 font-medium">
            Rows per page
            <select
              value={pageSize}
              onChange={(e) => handlePageSizeChange(parseInt(e.target.value, 10))}
              className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs font-semibold text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              aria-label="Rows per page"
            >
              {PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>{size}</option>
              ))}
              <option value={ALL_ROWS}>All ({tableData.length.toLocaleString()})</option>
            </select>
          </label>

          {/* Reads as a sentence about this file rather than a row of counters.
              Once a file has been filtered, "46 questions" and "46 with images"
              are the same number, so they collapse into one phrase. */}
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 tabular-nums">
            {imageReport.stats.withImages === 0 ? (
              <>
                <Stat label="questions" value={tableData.length} />
                <span className="text-gray-400">no images</span>
              </>
            ) : imageReport.stats.withImages === tableData.length ? (
              <>
                <Stat label="questions with images" value={tableData.length} tone="violet" />
                <Stat label="images in total" value={imageReport.stats.totalImages} tone="violet" />
              </>
            ) : (
              <>
                <Stat label="questions" value={tableData.length} />
                <Stat label="with images" value={imageReport.stats.withImages} tone="violet" />
                <Stat label="images in total" value={imageReport.stats.totalImages} tone="violet" />
              </>
            )}
          </span>

          {isFillingRows && (
            // Tells the user the remaining rows are still arriving, rather than
            // leaving them to wonder whether the table is short.
            <span className="flex items-center gap-1.5 text-blue-600 font-medium">
              <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />
              Loading rows…
            </span>
          )}
        </div>
      </div>

      {/* Pagination */}
      {tableData.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 bg-gray-50 rounded-lg">
          <div className="text-xs text-gray-600 font-medium tabular-nums">
            Showing rows{' '}
            <span className="text-gray-900 font-semibold">
              {(pageStart + 1).toLocaleString()}–{pageEnd.toLocaleString()}
            </span>{' '}
            of <span className="text-gray-900 font-semibold">{tableData.length.toLocaleString()}</span>
          </div>

          {pageCount > 1 && (
            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={() => goToPage(0)}
                disabled={currentPage === 0}
                title="First page"
                aria-label="First page"
              >
                <ChevronsLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => goToPage(currentPage - 1)}
                disabled={currentPage === 0}
                title="Previous page"
                aria-label="Previous page"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>

              <span className="px-3 text-xs text-gray-700 font-semibold tabular-nums whitespace-nowrap">
                Page {(currentPage + 1).toLocaleString()} of {pageCount.toLocaleString()}
              </span>

              <Button
                variant="outline"
                size="sm"
                onClick={() => goToPage(currentPage + 1)}
                disabled={currentPage >= pageCount - 1}
                title="Next page"
                aria-label="Next page"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => goToPage(pageCount - 1)}
                disabled={currentPage >= pageCount - 1}
                title="Last page"
                aria-label="Last page"
              >
                <ChevronsRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      )}

      <ActionDialog
        open={action !== null}
        title={
          action === 'translateImages'
            ? 'Translate the text inside the images'
            : action === 'imageText'
              ? 'Keep only images with text'
              : 'Keep only image questions'
        }
        state={actionState}
        progress={actionProgress}
        confirmLabel={
          action === 'translateImages'
            ? imgTrCachedOnly
              ? 'Show already-translated images (free)'
              : `Redraw ${imgTrCount} image(s) · ~$${imgTrEstimate.toFixed(2)}`
            : action === 'imageText'
              ? 'Analyse images'
              : 'Filter questions'
        }
        onConfirm={
          action === 'translateImages'
            ? runTranslateImages
            : action === 'imageText'
              ? runKeepImagesWithText
              : runKeepImageQuestions
        }
        onClose={closeAction}
      >
        {actionState === 'confirm' && action === 'images' && (
          <>
            <p>Remove every question that has no picture anywhere.</p>
            <ul className="list-disc pl-5 text-gray-600">
              <li><strong>{imageReport.stats.withImages.toLocaleString()}</strong> question(s) kept</li>
              <li><strong>{removableCount.toLocaleString()}</strong> question(s) removed</li>
              <li>{imageReport.stats.questionOnly} image in the question, {imageReport.stats.variantsOnly} in the variants, {imageReport.stats.both} in both</li>
            </ul>
            <p className="text-gray-500 text-xs">
              No AI is used. The result is saved as a separate file; the original stays in Files.
            </p>
          </>
        )}

        {actionState === 'confirm' && action === 'imageText' && (
          <>
            <p>
              Send each picture to <strong>{selectedModel}</strong> and keep only the questions whose
              images contain words.
            </p>
            <ul className="list-disc pl-5 text-gray-600">
              <li><strong>{imageReport.stats.withImages.toLocaleString()}</strong> question(s) will be examined</li>
              <li><strong>{imageReport.stats.totalImages.toLocaleString()}</strong> image(s) will be read</li>
            </ul>
            <p className="text-gray-600">
              Images with no text, or with only numbers, formulas or single-letter labels, count as
              nothing to translate - those questions are removed.
            </p>

            <label className="flex items-center gap-2 pt-1">
              <span className="font-medium text-gray-700">Keep text in</span>
              <select
                value={imageLanguage}
                onChange={(e) => setImageLanguage(e.target.value as ImageTextLanguage | 'any')}
                className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm font-semibold text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                {IMAGE_TEXT_LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>{lang.name}</option>
                ))}
                <option value="any">Any language</option>
              </select>
            </label>
            <p className="text-gray-500 text-xs">
              {imageLanguage === 'any'
                ? 'Any language counts, as long as the image contains real words.'
                : `Images whose words are in another language are treated like images with no text, and those questions are removed too.`}
            </p>
            <p className="text-gray-500 text-xs">
              Each image is charged once and then cached, so re-running is free. The result is saved
              as a separate file; the original stays in Files.
            </p>
          </>
        )}

        {actionState === 'confirm' && action === 'translateImages' && (
          <>
            <p>
              Send each picture to an image model and get it back redrawn with its words in the
              target language. Numbers, formulas and single-letter labels are left alone.
            </p>

            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="block font-medium text-gray-700">Translate into</span>
                <select
                  value={imgTrLanguage}
                  onChange={(e) => setImgTrLanguage(e.target.value)}
                  className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm font-semibold text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                >
                  {IMAGE_TEXT_LANGUAGES.map((lang) => (
                    <option key={lang.code} value={lang.name}>{lang.name}</option>
                  ))}
                </select>
              </label>

              <label className="space-y-1">
                <span className="block font-medium text-gray-700">How many</span>
                <select
                  value={imgTrLimit}
                  onChange={(e) => setImgTrLimit(parseInt(e.target.value, 10))}
                  className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm font-semibold text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                >
                  <option value={-1}>Already translated only — free</option>
                  <option value={3}>First 3 (try it out)</option>
                  <option value={10}>First 10</option>
                  <option value={25}>First 25</option>
                  <option value={0}>All {imageReport.stats.totalImages}</option>
                </select>
              </label>
            </div>

            <label className="block space-y-1">
              <span className="block font-medium text-gray-700">Model</span>
              <select
                value={imgTrModel}
                onChange={(e) => setImgTrModel(e.target.value)}
                className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm font-semibold text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                {IMAGE_TRANSLATE_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} — ~${m.costPerImage.toFixed(3)}/image
                  </option>
                ))}
              </select>
              <span className="block text-xs text-gray-500">{imgTrModelInfo.note}</span>
            </label>

            {imgTrCachedOnly ? (
              <div className="rounded-lg border border-green-300 bg-green-50 p-3 space-y-1">
                <p className="font-semibold text-green-900">Costs nothing</p>
                <p className="text-green-800 text-xs">
                  Builds a file from images already translated into this language with this model,
                  so you can open and check what you have paid for. No API calls are made.
                </p>
              </div>
            ) : (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-1">
                <p className="font-semibold text-amber-900">
                  Estimated cost: ${imgTrEstimate.toFixed(2)} for {imgTrCount} image(s)
                </p>
                <p className="text-amber-800 text-xs">
                  Images already redrawn into this language with this model are reused free of charge,
                  so the real figure is usually lower. Start with a few and check the result before
                  committing to the whole file.
                </p>
              </div>
            )}

            <p className="text-gray-500 text-xs">
              The model redraws the whole picture rather than patching pixels, so the diagram is
              reproduced rather than preserved byte for byte. The result is pinned to the original
              display size, your originals stay untouched in Files, and the output is saved as a
              separate file.
            </p>
          </>
        )}

        {actionState === 'running' && action === 'translateImages' && (
          <p className="text-gray-600">
            Redrawing images one at a time with {imgTrModelInfo.name}. Each one is saved as it
            finishes, so stopping here never loses what has been paid for.
            {imgTrSpent > 0 && <> Spent so far: <strong>${imgTrSpent.toFixed(2)}</strong>.</>}
          </p>
        )}

        {actionState === 'running' && action === 'imageText' && (
          <p className="text-gray-600">
            Reading the images. Cached ones are free and resolve instantly; the rest are sent to{' '}
            {selectedModel}.
          </p>
        )}

        {actionState === 'running' && action === 'images' && (
          <p className="text-gray-600">Filtering the questions…</p>
        )}

        {(actionState === 'done' || actionState === 'error') && (
          <div className={actionState === 'error' ? 'text-red-700' : undefined}>{actionMessage}</div>
        )}
      </ActionDialog>

      {/* Table */}
      <div className="border border-gray-200 rounded-lg shadow-sm overflow-hidden">
        <div 
          ref={scrollRef}
          className="data-table-scroll overflow-auto"
          style={{ 
            height: '70vh',
            maxHeight: '70vh',
            minHeight: '400px'
          }}
        >
          <Table className="w-full">
          <TableHeader className="sticky top-0 bg-white z-10 shadow-sm">
            <TableRow>
              <TableHead className="w-16 sticky left-0 bg-white z-20 border-r border-gray-200">Row</TableHead>
              {tableData[0]?.map((_, colIndex) => {
                let columnLabel = `Col ${colIndex}`;
                let columnClass = "min-w-48 whitespace-nowrap";
                
                if (colIndex === 0) {
                  columnLabel = "ID";
                  columnClass = "min-w-20 max-w-28 whitespace-nowrap bg-blue-50 font-semibold";
                } else if (colIndex === 1) {
                  columnLabel = "ID-Q";
                  columnClass = "min-w-24 max-w-32 whitespace-nowrap bg-blue-50 font-semibold";
                } else if (colIndex === 2) {
                  columnLabel = "Question";
                  columnClass = "min-w-72 whitespace-nowrap bg-green-50 font-semibold";
                } else if (isCodeColumn(colIndex)) {
                  columnLabel = `Code ${Math.floor((colIndex - 4) / 2) + 1}`;
                  columnClass = "min-w-20 max-w-24 whitespace-nowrap bg-red-50 font-semibold";
                } else if (colIndex >= 3) {
                  columnLabel = `Variant ${Math.floor((colIndex - 3) / 2) + 1}`;
                  columnClass = "min-w-48 whitespace-nowrap bg-yellow-50 font-semibold";
                }
                
                return (
                  <TableHead key={colIndex} className={columnClass}>
                    {columnLabel}
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleRows.map((row, indexOnPage) => {
              // Absolute index into tableData: row numbering, edit targets and
              // the onCellEdit/onCellDelete callbacks must all refer to the
              // file, not to the position within the current page.
              const rowIndex = pageStart + indexOnPage;
              return (
              <DataTableRow
                key={rowIndex}
                row={row}
                rowIndex={rowIndex}
                viewMode={viewMode}
                showAllColumns={SHOW_ALL_COLUMNS}
                editable={editable}
                showMetadata={showMetadata}
                editingCol={editingCell?.row === rowIndex ? editingCell.col : null}
                editValue={editingCell?.row === rowIndex ? editValue : EMPTY_EDIT_VALUE}
                onEditValueChange={setEditValue}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onSave={handleSave}
                onCancel={handleCancel}
              />
              );
            })}
          </TableBody>
        </Table>
        </div>
      </div>
    </div>
  );
}