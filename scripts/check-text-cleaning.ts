/**
 * Checks the spacing cleanup against what it must fix and what it must not touch.
 *
 * Run it with `npm run check:text`.
 *
 * This exists because the cleanup is about thirty overlapping regular
 * expressions and a wrong one is invisible: it does not throw, it quietly
 * damages a few thousand cells. Five of them were wrong at once in 3.4.0 -
 * removing correct spaces, splitting Roman numerals, breaking abbreviations and
 * reading a closing bracket as a list marker - and nothing said so. Every case
 * below is real text from a 1,636 question file.
 */
import { cleanGeminiTranslationErrors as clean, repairPiInCyrillicWords } from '../src/lib/text-cleaning';
import { fixMathExpressions } from '../src/lib/excel-processor';

type Case = [input: string, expected: string];

/** Markers welded to the text in front of them - the reported defect. */
const mustFix: Case[] = [
  [
    'uyğun müəyyən edin: Ərəb dövlətinə qarşı mübarizə aparmışdırb) Cavanşirə qarşı',
    'uyğun müəyyən edin: Ərəb dövlətinə qarşı mübarizə aparmışdır b) Cavanşirə qarşı'
  ],
  [
    'Ven diaqramına uyğun müəyyən edin:a) Ərəb dövlətinə qarşı',
    'Ven diaqramına uyğun müəyyən edin: a) Ərəb dövlətinə qarşı'
  ],
  [
    'Müvafiqliyi müəyyən edin:1. Xəzər xaqanlığı2. Uyğur xaqanlığı',
    'Müvafiqliyi müəyyən edin: 1. Xəzər xaqanlığı 2. Uyğur xaqanlığı'
  ],
  ['Sual?a) Birinci', 'Sual? a) Birinci'],
  ['Sual?I. Birinci II. İkinci', 'Sual? I. Birinci II. İkinci'],
  ['N₂O-dur2. Lakmusun rəngi', 'N₂O-dur 2. Lakmusun rəngi'],
  ['Cavab a.Paleogen dövrüdür', 'Cavab a. Paleogen dövrüdür']
];

/** Correct text. Each of these was damaged by a rule at some point. */
const mustNotTouch: string[] = [
  'birləşməsi c. Çindən gətirilmişdir',
  'aaaa c. Çindən',
  'Bu suala cavab verin: a) Bakı b) Gəncə c) Sumqayıt',
  'Cavab: 1. Birinci 2. İkinci 3. Üçüncü',
  'Roma imperatoru I. Konstantin dövründə',
  'Napoleon I. Fransa imperatoru idi',
  'XXVI. İltəris xan:',
  'VIII. İkinci Gəytürk dövlətinin yaradılması',
  'Paytaxtı (Bakı) olan ölkə',
  'Dövlətin qurucusu (Alptekin) sayılır',
  'Cavab 2 (iki) olmalıdır',
  'tətbiqini tələb edirdi. Kişi əmək tələbi artdı.',
  'ikinci şəxs baş vizir idi. Onun ardınca',
  'Bu proses davam edirdi. Xalq narazı idi.',
  'Kədim Misir tarixinin II minilliyi e.ə. aid deyil:',
  'Uzunluq 5 sm-dir və en 3 sm-dir.',
  'Suyun formulu H2O-dur.',
  'Tərəflərin nisbəti 2:3. Sonra hesablayın.',
  'Dərs saat 9:5. Bitir.'
];

/** A π that is really a Cyrillic п, and one that is really pi. */
const piCases: Case[] = [
  ['Оπределите столиц', 'Определите столиц'],
  ['Кто был автором «Каπитала»?', 'Кто был автором «Капитала»?'],
  ['социальных груππ?', 'социальных групп?'],
  ['Sahə 2πR düsturu ilə', 'Sahə 2πR düsturu ilə'],
  ['π = 3.14', 'π = 3.14']
];

/** The upload must only read п as pi when a number comes first. */
const mathCases: Case[] = [
  ['2&#1087;', '2&#960;'],
  ['2&#1087;<sup>2</sup>', '2&#960;<sup>2</sup>'],
  ['площадь = 4&#1087;R', 'площадь = 4&#960;R'],
  ['&#1054;&#1087;&#1088;&#1077;&#1076;', '&#1054;&#1087;&#1088;&#1077;&#1076;'],
  ['&#1087;&#1077;&#1088;&#1074;&#1099;&#1081;', '&#1087;&#1077;&#1088;&#1074;&#1099;&#1081;']
];

let failed = 0;
let passed = 0;

function check(label: string, input: string, expected: string, got: string): void {
  if (got === expected) {
    passed++;
    return;
  }
  failed++;
  console.error(`FAIL  ${label}`);
  console.error(`      in   ${JSON.stringify(input)}`);
  console.error(`      want ${JSON.stringify(expected)}`);
  console.error(`      got  ${JSON.stringify(got)}`);
}

for (const [input, expected] of mustFix) check('fixes', input, expected, clean(input));
for (const input of mustNotTouch) check('leaves alone', input, input, clean(input));
for (const [input, expected] of piCases) {
  check('pi', input, expected, repairPiInCyrillicWords(input));
}
for (const [input, expected] of mathCases) {
  check('upload pi', input, expected, fixMathExpressions(input));
}

const total = passed + failed;
if (failed === 0) {
  console.log(`text cleaning: all ${total} checks passed`);
} else {
  console.error(`\ntext cleaning: ${failed} of ${total} checks FAILED`);
  process.exit(1);
}
