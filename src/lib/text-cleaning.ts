/**
 * Shared utility functions for cleaning Gemini translation errors
 * Used in translation service, export functions, and file cleaning
 */

/**
 * Puts back a Cyrillic п that was turned into a Greek π.
 *
 * Uploads before this version replaced every &#1087; with &#960;, on the theory
 * that п in these workbooks usually meant pi. In entity-encoded Russian it does
 * not: "Определите" was stored as "Оπределите" and the translation model was
 * then handed Russian it could not read, so it handed the text back untouched.
 * Measured on two real files, all 1,686 π produced that way were letters.
 *
 * Applied per word, so a π that shares a word with a Cyrillic letter is a
 * letter, and a standalone or numeric one ("2π", "πR²") is maths and is kept.
 * The upload no longer creates these, but files already stored carry them.
 */
export function repairPiInCyrillicWords(text: string): string {
  if (!text || !text.includes('π')) return text;
  return text.replace(/[^\s<>]*π[^\s<>]*/g, (word) =>
    /[а-яё]/i.test(word) ? word.replace(/π/g, 'п') : word
  );
}

/**
 * True when the ")" at `offset` closes a bracket that is still open.
 *
 * The marker rules below look for a letter or digit welded to the word in front
 * of it and followed by ")". A closing bracket looks exactly like that:
 * "(Alptekin) sayılır" parses as the word "Alpteki" plus the marker "n)", and
 * without this check comes back as "(Alpteki n) sayılır".
 */
function closesOpenBracket(text: string, offset: number): boolean {
  let open = 0;
  for (let i = 0; i < offset; i++) {
    const char = text[i];
    if (char === '(') open++;
    else if (char === ')' && open > 0) open--;
  }
  return open > 0;
}

/**
 * Cleans common Gemini translation formatting errors
 * - Fixes word splitting before periods (e.g., "edi n." → "edin.")
 * - Fixes markers stuck to words (e.g., "edin.a." → "edin. a.")
 * - Fixes π (pi) used incorrectly in non-math contexts (should be п)
 * - Adds missing spaces between merged words
 * - Fixes spacing issues in Azerbaijani text
 * - Supports both period markers (1. 2.) and parentheses markers (1) 2))
 */
export function cleanGeminiTranslationErrors(text: string): string {
  if (!text) return text;
  
  // FIX -1: Azerbaijani-specific fixes (apply early, before other fixes)
  // CRITICAL: Apply merged marker fixes FIRST, before any other processing
  
  // Fix 1: Missing spaces before letter markers (a., b., c., etc.)
  // "ədədlərib." -> "ədədləri b."
  // "varb." -> "var b."
  // "yoxdurc." -> "yoxdur c."
  // "vard." -> "var d." (if followed by space/text, but "vard." alone is "vard" + ".")
  // Handle common words that often have merged markers - MUST BE FIRST
  // Fix 1: Split merged markers with common words - AGGRESSIVE PATTERN
  // Handle ALL cases: "varb.", "varb. a", "yoxdurc.", "bərabərdird.", etc.
  // Pattern 1: var/word + letter + period + space + letter/text
  text = text.replace(/\b(var)([a-z])\.(\s+[a-zа-яА-ЯӘƏİÖÜĞŞÇəöüğşçı])/gi, '$1 $2.$3');
  text = text.replace(/\b(yoxdur)([a-z])\.(\s+[a-zа-яА-ЯӘƏİÖÜĞŞÇəöüğşçı])/gi, '$1 $2.$3');
  
  // Fix 1b: Split "bərabərdir" + letter marker patterns (Problem 2)
  // "bərabərdirb." → "bərabərdir b."
  // "bərabərdirc." → "bərabərdir c."
  // "bərabərdird." → "bərabərdir d."
  // "bərabərdire." → "bərabərdir e."
  // More aggressive - don't require word boundary if word ends with 'ir'
  text = text.replace(/(bərabərdir)([a-z])\.(\s*)/gi, '$1 $2.$3');
  
  // Fix 1c: Split "bölünür" + letter marker patterns (Problem 1)
  // "bölünürb." → "bölünür b."
  // "bölünürc." → "bölünür c."
  // "bölünürd." → "bölünür d."
  // "bölünüre." → "bölünür e."
  // More aggressive - don't require word boundary
  text = text.replace(/(bölünür)([a-z])\.(\s*)/gi, '$1 $2.$3');
  
  // Fix 1d: Split "bilər" + letter marker patterns (Problem 1)
  // "bilərd." → "bilər d."
  // More aggressive - don't require word boundary
  text = text.replace(/(bilər)([a-z])\.(\s*)/gi, '$1 $2.$3');
  
  // Fix 1e: Generic pattern for any word ending with letter marker a-e (aggressive fallback)
  // This catches remaining cases like: "ədədləria." → "ədədləri a."
  // Matches: word (4+ chars) + letter (a-e) + period + (space OR letter/text after)
  // More aggressive - works even without space after, as long as there's text after
  text = text.replace(/([а-яА-Яa-zA-Zəöüğşçı]{4,})([a-e])\.(\s*[a-zа-яА-ЯӘƏİÖÜĞŞÇəöüğşçı])/gi, (match, word, letter, after) => {
    // Ensure there's a space before the letter marker in the replacement
    return word + ' ' + letter + '.' + after;
  });
  
  // Pattern 2: Handle "vard." followed by space + letter (list marker)
  text = text.replace(/\b(vard)\.(\s+[a-zа-яА-ЯӘƏİÖÜĞŞÇəöüğşçı])/gi, 'var d.$2');
  
  // Pattern 3: Handle markers at end or before space (b., c., e. for var; all for yoxdur)
  // But NOT "vard." at end (it means "there are")
  text = text.replace(/\b(var)([bce])\.(\s|$|[a-zа-яА-ЯӘƏİÖÜĞŞÇəöüğşçı])/gi, (match, word, letter, after) => {
    // Only split if followed by space, end, or letter (not if it's part of word)
    if (/^\s|^$|^[a-zа-яА-ЯӘƏİÖÜĞŞÇəöüğşçı]/.test(after)) {
      return word + ' ' + letter + '.' + (after === '' ? '' : after);
    }
    return match;
  });
  text = text.replace(/\b(yoxdur)([a-z])\.(\s|$|[a-zа-яА-ЯӘƏİÖÜĞŞÇəöüğşçı])/gi, '$1 $2.$3');
  
  // Pattern 4: Catch any remaining var/word + letter + period patterns
  // This is a fallback for edge cases
  text = text.replace(/\b(var)([a-z])\.(?=\s|$|[a-zа-яА-ЯӘƏİÖÜĞŞÇəöüğşçı])/gi, (match, word, letter, offset, fullText) => {
    // Skip if it's "vard." at absolute end (means "there are")
    const afterMatch = fullText.substring(offset + match.length);
    if (!afterMatch.trim() && letter.toLowerCase() === 'd') {
      return match; // Keep "vard." at end
    }
    // Otherwise split it
    return word + ' ' + letter + '.';
  });
  
  // General pattern for other cases - word ending + letter marker.
  //
  // The marker is a LOWERCASE a-e, the letters these papers use for options,
  // and the rule is case-sensitive. While it was case-insensitive over [a-z] it
  // read the Roman numeral "XXVI." as the word "XXV" plus the marker "I." and
  // split it into "XXV I.", which happened to every VIII, XXVI and XXVIII.
  text = text.replace(/([а-яА-ЯёЁa-zA-Zəöüğşçıİ]{2,})([a-e])\.(\s+[a-zа-яА-ЯӘƏİÖÜĞŞÇəöüğşçı]|$|\s*[a-e]\.)/g, (match, before, letter, after) => {
    // Only add space if it's a single letter marker (a-z)
    if (/^[a-z]$/i.test(letter)) {
      // Skip if it's a complete word that shouldn't be split (like "vard" meaning "there is/are")
      const completeWords = ['vard', 'vardır'];
      const beforeLower = before.toLowerCase();
      // Only skip if it's exactly the word AND not followed by space + letter (which would indicate a marker)
      if (completeWords.some(w => beforeLower === w && (!after || !/^\s+[a-zа-яӘƏİÖÜĞŞÇəöüğşçı]/.test(after)))) {
        return match;
      }
      // Split if followed by space + letter/text or at end with typical marker
      if (after && /\s+[a-zа-яА-ЯӘƏİÖÜĞŞÇəöüğşçı]/.test(after)) {
        return before + ' ' + letter + '.' + after;
      }
      if (!after && /[bcde]$/i.test(letter)) {
        return before + ' ' + letter + '.';
      }
    }
    return match;
  });
  
  // Fix 2: Missing spaces before numbered markers
  // "edini." -> "edini. " (but this might be wrong, let's be more specific)
  // "müəyyən edin.1." -> "müəyyən edin. 1."
  text = text.replace(/([а-яА-Яa-zA-Zəöüğşçı])\.([1-9]\d?\.)/g, '$1. $2');
  
  // Fix 3: Merged words in Azerbaijani
  // "ədd i" -> "əddi" (but be careful - might need context)
  // Actually, "ədd i" should become "əddi" - but this is complex
  // Better to handle specific cases
  text = text.replace(/əd\s+ə(?=\s|$|\.|,|;)/gi, 'ədə');
  
  // Fix 4: Spacing around equals signs - CRITICAL for Azerbaijani
  // "ƏBOB (m, n)= 15" -> "ƏBOB (m, n) = 15"
  // "n)= 15" -> "n) = 15"
  text = text.replace(/([)\]])\s*=\s*(\d)/g, '$1 = $2');
  text = text.replace(/([)\]])\s*=\s*([a-zA-Zа-яА-Яəöüğşçı])/g, '$1 = $2');
  
  // Fix 5: Missing space after a single-letter marker: "a.Paleogen" -> "a. Paleogen"
  //
  // Not when the next letter carries its own period, because that is an
  // abbreviation rather than a marker: "e.ə." (eramızdan əvvəl) must stay
  // welded, and the rule used to break it into "e. ə.".
  text = text.replace(/([a-z])\.(?=[а-яА-Яa-zA-Zəöüğşçı](?!\.))/gi, '$1. ');
  
  // Fix 6: Handle specific merged patterns FIRST (more precise)
  // "ədədlərib." -> "ədədləri b."
  text = text.replace(/(ədədləri)([a-z])\./gi, '$1 $2.');
  text = text.replace(/(ədədləri)([a-z])(?=\s)/gi, '$1 $2');
  
  // Fix 6a: Missing spaces between Azerbaijani words and letter markers (general case)
  // Match word ending + single letter marker (a-z) followed by period
  // Use more specific pattern to avoid false positives
  text = text.replace(/([əöüğşçıа-яА-Я]{4,}[ləriindəəiıüö])([a-e])\.(?=\s|$|[a-e]\.)/g, (match, word, letter) => {
    // Only process if it's a single letter marker (a-z)
    if (/^[a-z]$/i.test(letter)) {
      return word + ' ' + letter + '.';
    }
    return match;
  });
  
  // FIX 0: Fix π (pi) incorrectly used instead of п (Cyrillic pe) in NON-math contexts
  // Only replace π with п if it's NOT followed by superscript/subscript/math operators
  text = text.replace(/π(?![\d²³¹⁰⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿ<])/g, (match, offset, str) => {
    const before = str.substring(Math.max(0, offset - 10), offset);
    const after = str.substring(offset + 1, Math.min(str.length, offset + 10));
    
    // If π is preceded by a digit and followed by math symbols, keep it (it's math)
    if (/[\d²³¹⁰⁴⁵⁶⁷⁸⁹]/.test(before) && /[²³¹⁰⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿ<]/.test(after)) {
      return match; // Keep π for math
    }
    
    // If π is in a word context (like "πараметра", "πри"), replace with п
    if (/[а-яА-Я]/.test(after)) {
      return 'п'; // Replace π with п in Cyrillic text
    }
    
    return match;
  });
  
  // FIX 0d: Fix incorrectly split words FIRST (reverse splitting errors)
  // These MUST come BEFORE the merging fixes to avoid conflicts
  // "иррацион альные" -> "иррациональные"
  text = text.replace(/иррацион\s+альные/gi, 'иррациональные');
  
  // "ост атка" -> "остатка"
  text = text.replace(/ост\s+атка/gi, 'остатка');
  text = text.replace(/ост\s+атком/gi, 'остатком');
  
  // "знак ами" -> "знаками"
  text = text.replace(/знак\s+ами(?=\s|$|\.|,|;)/gi, 'знаками');
  
  // FIX 0a: Fix "при а" / "приа" - add space between "при" and "а" when merged
  // "приа = 0" -> "при а = 0"
  // Do this AFTER fixing splits but BEFORE other merges
  text = text.replace(/при([а])(?=\s*[=<>])/gi, 'при а');
  text = text.replace(/при([а])(?=\s)/gi, 'при а'); // Also match with space after
  
  // FIX 0b: Handle merged words - add spaces before common Russian/Cyrillic words
  // More comprehensive list including mathematical terms
  const commonWords = [
    'соответствие', 'имеет', 'имеетдва', 'корня', 'корни', 'корней', 
    'равных', 'разных', 'целых', 'противоположными', 'действительных', 
    'параметр', 'натурального', 'числа', 'число', 'чисел', 'кратное', 
    'общее', 'наименьшее', 'произведению', 'сумма', 'делится', 'утверждения'
  ];
  commonWords.forEach(word => {
    // Match word merged with previous text (Cyrillic letter followed by word)
    const pattern = new RegExp(`([а-яА-Я]{2,})${word}(?=[а-яА-Я\\s.,;:!?])`, 'gi');
    text = text.replace(pattern, `$1 ${word}`);
  });
  
  // FIX 0c: Fix specific merged word patterns (more precise than general regex)
  // "противоположнымизнак" -> "противоположными знак"
  // "противоположнымизнаками" -> "противоположными знаками"
  text = text.replace(/противоположными([знак])/gi, 'противоположными $1');
  
  // "натуральногочисла" -> "натурального числа"
  text = text.replace(/натурального([числ])/gi, 'натурального $1');
  
  // "нечетныхчисел" -> "нечетных чисел"
  text = text.replace(/нечетных([числ])/gi, 'нечетных $1');
  
  // "Какиеутверждения" -> "Какие утверждения"
  text = text.replace(/Какие([утв])/gi, 'Какие $1');
  
  // "Установитесоответствие" -> "Установите соответствие"
  text = text.replace(/Установите([со])/gi, 'Установите $1');
  
  // "имеетдва" -> "имеет два"
  text = text.replace(/имеет([дв])/gi, 'имеет $1');
  
  // "параметраа" -> "параметра а" (double а after parameter)
  text = text.replace(/параметра([аеиоуюя])(?=\s*[=<>])/gi, 'параметра $1');
  
  // "приа = " -> "при а = "
  text = text.replace(/при([а-яА-Я])(?=\s*[=<>])/gi, (match, letter) => {
    if (letter.toLowerCase() === 'а') {
      return 'при а';
    }
    return match;
  });
  
  // "параметр аа" -> "параметра а" (handle double а)
  text = text.replace(/параметр\s*а\s*а/gi, 'параметра а');
  
  // FIX 0e: Fix spacing around "=" signs - MUST come after word fixes
  // "при а= 2" -> "при а = 2"
  // "при а =2" -> "при а = 2"
  text = text.replace(/при\s+а\s*=\s*/gi, 'при а = ');
  
  // Fix spacing around equals for any parameter: "а= 3" -> "а = 3", "а =3" -> "а = 3"
  text = text.replace(/([а-яА-Я])\s*=\s*(\d)/gi, '$1 = $2');
  
  // Fix spacing around equals in Azerbaijani/mixed contexts
  // Handle "= " and " =" patterns more generally
  text = text.replace(/([^\s])\s*=\s*(\d)/g, '$1 = $2');
  text = text.replace(/([^\s])\s*=\s*([a-zA-Zа-яА-Яəöüğşçı])/g, '$1 = $2');
  
  // FIX 0f: Fix missing spaces in Azerbaijani after periods
  // "edin.1." -> "edın. 1."
  text = text.replace(/([а-яА-Яa-zA-Zəöüğşçı])\.([1-9])/g, '$1. $2');
  
  // FIX 1: a word's last letter split off before a period, the most common
  // Gemini mistake: "edi n." -> "edin.", "vermişdi r." -> "vermişdir."
  //
  // Only lowercase r, n and i. Those three cannot be list markers, while
  // "a." to "e." and Roman "I." can, and gluing a marker onto the word before
  // it is the very defect this file exists to remove. The earlier version was
  // case-insensitive, so it turned "imperatoru I. Konstantin" into
  // "imperatoruI." and a later rule had to undo it.
  text = text.replace(/([a-zA-Zа-яёА-ЯЁәəıiöüğşçÖÜĞŞÇİ]+)\s+([rni])\./g, '$1$2.');

  // There used to be a FIX 2 here that did the same for ANY single letter:
  //
  //   /([a-zа-яәəıöüğşçа-я]{2,})\s+([a-zа-яәəıöüğşçа-я])\./g -> '$1$2.'
  //
  // It is gone because it destroys correctly spaced text. "birləşməsi c. Çindən"
  // came back as "birləşməsic. Çindən": every option marker written properly,
  // with a space in front of it, was glued to the word before it. That is the
  // opposite of what this file is for, and it fired on every list in the file.

  // FIX 3: Add space before lettered markers stuck to previous text (handle space, end, or capital letter after)
  // Example: "edin.a.Paleogen" -> "edin. a. Paleogen"
  text = text.replace(/([a-zа-яәəıöüğşçа-я]{2,})\.([a-z])\.(\s|$|[A-ZА-ЯӘƏİÖÜĞŞÇ])/gi, (match, p1, p2, p3) => {
    // If p3 is a capital letter, add space and keep the letter; if space, keep it; if end, add space
    if (p3 && /[A-ZА-ЯӘƏİÖÜĞŞÇ]/.test(p3)) {
      return p1 + '. ' + p2 + '. ' + p3;
    }
    return p1 + '. ' + p2 + '.' + (p3 === ' ' ? ' ' : ' ');
  });

  // FIX 4: Add space before numbered markers stuck to previous text (handle space, end, or capital letter after)
  // Example: "edin.1.Text" -> "edin. 1. Text" or "word.10.Text" -> "word. 10. Text"
  text = text.replace(/([a-zа-яәəıöüğşçа-я]{2,})\.([1-9]\d?)\.(\s|$|[A-ZА-ЯӘƏİÖÜĞŞÇ])/gi, (match, p1, p2, p3) => {
    // If p3 is a capital letter, add space and keep the letter; if space, keep it; if end, add space
    if (p3 && /[A-ZА-ЯӘƏİÖÜĞŞÇ]/.test(p3)) {
      return p1 + '. ' + p2 + '. ' + p3;
    }
    return p1 + '. ' + p2 + '.' + (p3 === ' ' ? ' ' : ' ');
  });

  // FIX 5: Add space before lettered markers with parentheses stuck to previous text
  // Example: "aparmışdırb) Cavanşirə" -> "aparmışdır b) Cavanşirə"
  //
  // Restricted to a-e, the letters these papers actually use for options, and
  // skipped when the ")" closes a bracket that is still open. Without those two
  // guards "(Alptekin) sayılır" reads as the word "Alpteki" plus the marker
  // "n)" and comes back as "(Alpteki n) sayılır".
  text = text.replace(
    /([a-zA-Zа-яёА-ЯЁәəıiöüğşçÖÜĞŞÇİ]{2,})([a-e])\)(\s|$|[A-ZА-ЯӘƏİÖÜĞŞÇ])/g,
    (match, p1, p2, p3, offset: number, whole: string) => {
      if (closesOpenBracket(whole, offset)) return match;
      if (p3 && /[A-ZА-ЯӘƏİÖÜĞŞÇ]/.test(p3)) {
        return p1 + ' ' + p2 + ') ' + p3;
      }
      return p1 + ' ' + p2 + ')' + (p3 === ' ' ? ' ' : ' ');
    }
  );

  // FIX 6: Add space before numbered markers with parentheses stuck to previous text
  // Example: "word1)Paleogen" -> "word 1) Paleogen" or "word10)Paleogen" -> "word 10) Paleogen"
  text = text.replace(
    /([a-zA-Zа-яёА-ЯЁәəıiöüğşçÖÜĞŞÇİ]{2,})([1-9]\d?)\)(\s|$|[A-ZА-ЯӘƏİÖÜĞŞÇ])/g,
    (match, p1, p2, p3, offset: number, whole: string) => {
      if (closesOpenBracket(whole, offset)) return match;
      if (p3 && /[A-ZА-ЯӘƏİÖÜĞŞÇ]/.test(p3)) {
        return p1 + ' ' + p2 + ') ' + p3;
      }
      return p1 + ' ' + p2 + ')' + (p3 === ' ' ? ' ' : ' ');
    }
  );

  // FIX 6b: a marker welded to the colon or question mark that introduces it.
  // "müəyyən edin:a) Ərəb"   -> "müəyyən edin: a) Ərəb"
  // "müəyyən edin:1. Xəzər"  -> "müəyyən edin: 1. Xəzər"
  //
  // Written as a lookahead, so only a space is inserted and nothing is rebuilt:
  // nothing that was already correct can be lost. A colon has to follow a
  // letter, which keeps a ratio out of it - "nisbət 2:3. Sonra" is not a list.
  text = text.replace(
    /([a-zA-Zа-яёА-ЯЁəöüğşçıİƏÖÜĞŞÇ]:)(?=[a-e1-9][).]\s*[A-ZА-ЯӘƏİÖÜĞŞÇ0-9])/g,
    '$1 '
  );
  text = text.replace(/(\?)(?=[a-e1-9][).]\s*[A-ZА-ЯӘƏİÖÜĞŞÇ0-9])/g, '$1 ');

  // FIX 6c: a numbered marker welded to the end of the previous option.
  // "Xəzər xaqanlığı2. Uyğur" -> "Xəzər xaqanlığı 2. Uyğur"
  // The marker must follow a letter, which leaves years ("1941.") and formulas
  // ("H2O") alone, and a capital has to start the option after it.
  text = text.replace(/([a-zа-яёəıöüğşç]{3})(?=[1-9]\.\s*[A-ZА-ЯӘƏİÖÜĞŞÇ])/g, '$1 ');
  
  // FIX 7: Fix missing space/line break after question mark before options (MUST BE EARLY)
  // "question?I. Option" -> "question? I. Option"
  // "question?1. Option" -> "question? 1. Option"
  // Handle both Roman numerals (I., II., III., IV., V., etc.) and Arabic numerals (1., 2., 3., etc.)
  //
  // Every Roman-numeral rule from here down is case-SENSITIVE. With /i the
  // class [IVX] also matches lowercase i, v and x, so "tələb edirdi. Kişi" was
  // read as the word "edird" followed by the marker "i." and came back as
  // "edird i. Kişi". Azerbaijani words ending in -i before a full stop are
  // everywhere, so that one flag damaged ordinary sentences all over the file.
  text = text.replace(/([?])\s*([IVX]+\.)/g, '$1 $2');
  text = text.replace(/([?])\s*([1-9]\d?\.)/g, '$1 $2');

  // FIX 8: Fix missing spaces between consecutive options (when options are directly adjacent)
  // "I.II." -> "I. II." or "1.2." -> "1. 2."
  text = text.replace(/([IVX]+\.)([IVX]+\.)/g, '$1 $2');
  text = text.replace(/([1-9]\d?\.)([1-9]\d?\.)/g, '$1 $2');

  // FIX 9: Fix missing spaces when option text ends and next option starts
  // "N₂O-dur2. Lakmusun" -> "N₂O-dur 2. Lakmusun"
  // Pattern: word/text ending (2+ chars, can include numbers/subscripts) + number + period + capital letter or space
  // This handles cases like "dur2." where the option text ends and next option starts
  text = text.replace(/([a-zA-Zа-яёА-ЯЁәəıiöüğşçÖÜĞŞÇİ0-9₀-₉₂₃₄₅₆₇₈₉\-]{2,})([1-9]\d?\.)(\s*[A-ZА-ЯӘƏİÖÜĞŞÇ]|\s*[IVX]+\.)/g, '$1 $2$3');
  // Pattern: word/text ending + Roman numeral + period + capital letter or space
  text = text.replace(/([a-zа-яәəıöüğşç0-9₀-₉₂₃₄₅₆₇₈₉\-]{2,})([IVX]+\.)(\s*[A-ZА-ЯӘƏİÖÜĞŞÇ]|\s*[1-9]\d?\.)/g, '$1 $2$3');

  // FIX 11: Fix options that are merged with previous text (no space before option marker)
  // "textI." -> "text I." (when I. is at start of option)
  // "text1." -> "text 1." (when 1. is at start of option)
  // But be careful: only apply when followed by capital letter or space (indicating new option)
  text = text.replace(/([a-zа-яәəıöüğşç]{2,})([IVX]+\.)(\s+[A-ZА-ЯӘƏİÖÜĞŞÇ]|\s*[A-ZА-ЯӘƏİÖÜĞŞÇ])/g, '$1 $2$3');
  text = text.replace(/([a-zа-яәəıöüğşç]{2,})([1-9]\d?\.)(\s+[A-ZА-ЯӘƏİÖÜĞŞÇ]|\s*[A-ZА-ЯӘƏİÖÜĞŞÇ])/gi, '$1 $2$3');

  // FIX 12: Ensure proper spacing for options with parentheses
  // "text(I." -> "text (I." or "text1)" -> "text 1)"
  text = text.replace(/([a-zа-яәəıöüğşç]{2,})(\([IVX]+\.)/g, '$1 $2');
  text = text.replace(/([a-zа-яәəıöüğşç]{2,})(\([1-9]\d?\.)/gi, '$1 $2');
  
  // FIX 7: Clean up multiple spaces created by fixes
  text = text.replace(/\s{2,}/g, ' ');
  
  return text;
}

