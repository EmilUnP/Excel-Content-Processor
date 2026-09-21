/**
 * Finds translated rows where answer options were mixed into the question cell.
 *
 * Usage:
 *   npx tsx scripts/check-merged-variants.ts
 *   npx tsx scripts/check-merged-variants.ts data/files/some_translated_az.json
 *
 * With no path, scans every *_translated_*.json under data/files.
 */
import fs from 'fs';
import path from 'path';
import {
  findMergedQuestionsInFile,
  looksContentMerged,
  looksPartiallyUntranslated,
  looksQuestionVariantSwap,
  countOptionMarkers
} from '../src/lib/translation-structure';
import { CellData } from '../src/types';

type Case = { name: string; source: string; output: string; expectMerged: boolean };

const unitCases: Case[] = [
  {
    name: 'trailing 1. leaked onto question',
    source: 'İngiltərədə baş vermiş hadisələrin xronoloji ardıcıllığını müəyyən edin:',
    output: 'İngiltərədə baş vermiş hadisələrin xronoloji ardıcıllığını müəyyən edin: 1.',
    expectMerged: true
  },
  {
    name: 'full option list pasted into question',
    source: 'Təqvim sırasını müəyyən edin:',
    output:
      'Təqvim sırasını müəyyən edin: 1. Roma ordusunun Frakiya döyüşündə məğlubiyyəti 2. Avropada ilk dövlətin yaranması 3. Çində mübariz krallıqlar 4. Manna dövlətinin yaranması',
    expectMerged: true
  },
  {
    name: 'normal short question unchanged structure',
    source: 'Determine the chronological sequence of events in England:',
    output: 'İngiltərədə baş vermiş hadisələrin xronoloji ardıcıllığını müəyyən edin:',
    expectMerged: false
  },
  {
    name: 'era abbreviation e.ə. is not an option list',
    source: 'Общая черта истории Индии VI века до н.э. и Греции V века до н.э.:',
    output: 'İndiyanın e.ə. VI əsri ilə Yunanıstanın e.ə. V əsri arasındakı ümumi xüsusiyyət:',
    expectMerged: false
  },
  {
    name: 'spaced a ) markers already in source are fine',
    source:
      'Определите соответствие: a ) вело борьбу с арабами b ) одержало победу c ) подверглось походу d ) вело борьбу e ) пало',
    output:
      'Uyğunluğu müəyyən edin: a) ərəbələrlə mübarizə aparmışdır b) qələbə qazanmışdır c) yürüşə məruz qalmışdır d) mübarizə aparmışdır e) düşmüşdür',
    expectMerged: false
  },
  {
    name: 'cell that already had options keeps them',
    source: 'Choose: 1. One 2. Two 3. Three',
    output: 'Seçin: 1. Bir 2. İki 3. Üç',
    expectMerged: false
  }
];

type PartialCase = {
  name: string;
  source: string;
  output: string;
  expectPartial: boolean;
};

const partialCases: PartialCase[] = [
  {
    name: 'mixed AZ + leftover Russian',
    source: 'Определите соответствие согласно диаграмме: a) борьба b) победа',
    output: 'Uyğunluğu müəyyən edin: a) борьба b) победа',
    expectPartial: true
  },
  {
    name: 'fully translated AZ',
    source: 'Определите соответствие согласно диаграмме: a) борьба b) победа',
    output: 'Uyğunluğu müəyyən edin: a) mübarizə b) qələbə',
    expectPartial: false
  }
];

type SwapCase = {
  name: string;
  qSrc: string;
  qOut: string;
  vSrc: string;
  vOut: string;
  expectSwap: boolean;
};

const swapCases: SwapCase[] = [
  {
    name: 'question body landed in variant',
    qSrc: 'С 1933 года Новый курс Рузвельта включал контроль банковской системы и общественные работы. Определите сущность политики.',
    qOut: '1933-cü ildən etibarən',
    vSrc: 'возрождение частного предпринимательства',
    vOut:
      'Dövlət nəzarəti bank sisteminə, ictimai işlər, sənaye və kənd təsərrüfatının bərpası. Yuxarıda qeyd olunanlara əsaslanaraq F. Roosevelt-in siyasətinin əsas mahiyyətini müəyyən edin.',
    expectSwap: true
  },
  {
    name: 'normal short variant',
    qSrc: 'Определите сущность политики Рузвельта на основе текста.',
    qOut: 'Mətnə əsasən Roosevelt siyasətinin mahiyyətini müəyyən edin.',
    vSrc: 'возрождение частного предпринимательства',
    vOut: 'şəxsi sahibkarlığın canlanması',
    expectSwap: false
  }
];

function runUnitChecks(): boolean {
  let ok = true;
  for (const c of unitCases) {
    const got = looksContentMerged(c.source, c.output);
    if (got !== c.expectMerged) {
      ok = false;
      console.error(`FAIL ${c.name}: expected merged=${c.expectMerged}, got ${got}`);
      console.error(`  markers ${countOptionMarkers(c.source)} -> ${countOptionMarkers(c.output)}`);
    } else {
      console.log(`ok  ${c.name}`);
    }
  }
  for (const c of partialCases) {
    const got = looksPartiallyUntranslated(c.source, c.output, 'az');
    if (got !== c.expectPartial) {
      ok = false;
      console.error(`FAIL ${c.name}: expected partial=${c.expectPartial}, got ${got}`);
    } else {
      console.log(`ok  ${c.name}`);
    }
  }
  for (const c of swapCases) {
    const got = looksQuestionVariantSwap(c.qSrc, c.qOut, c.vSrc, c.vOut);
    if (got !== c.expectSwap) {
      ok = false;
      console.error(`FAIL ${c.name}: expected swap=${c.expectSwap}, got ${got}`);
    } else {
      console.log(`ok  ${c.name}`);
    }
  }
  return ok;
}

function loadCells(filePath: string): CellData[] {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (Array.isArray(raw?.cells)) return raw.cells as CellData[];
  if (Array.isArray(raw)) return raw as CellData[];
  throw new Error(`No cells array in ${filePath}`);
}

function listTranslatedFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.includes('_translated_') && f.endsWith('.json'))
    .map((f) => path.join(dir, f));
}

function auditFile(filePath: string): number {
  const cells = loadCells(filePath);
  const hits = findMergedQuestionsInFile(cells);
  console.log(`\n${path.basename(filePath)}: ${hits.length} suspicious row(s)`);
  for (const hit of hits) {
    console.log(
      `  - ${hit.idQ} (row ${hit.rowIndex + 1}): ${hit.reason}` +
        ` [markers ${hit.sourceMarkers}->${hit.translatedMarkers}, len ${hit.sourceLen}->${hit.translatedLen}]`
    );
    console.log(`    ${hit.questionPreview.replace(/\s+/g, ' ')}`);
  }
  return hits.length;
}

function main(): void {
  console.log('Unit checks for merge detection:');
  const unitsOk = runUnitChecks();
  if (!unitsOk) {
    process.exitCode = 1;
    return;
  }

  const arg = process.argv[2];
  const files = arg
    ? [path.resolve(arg)]
    : listTranslatedFiles(path.resolve('data/files'));

  if (files.length === 0) {
    console.log('\nNo translated JSON files to audit.');
    return;
  }

  let total = 0;
  for (const file of files) {
    try {
      total += auditFile(file);
    } catch (error) {
      console.error(`Could not audit ${file}:`, error);
      process.exitCode = 1;
    }
  }

  console.log(`\nTotal suspicious rows: ${total}`);
  if (total > 0) process.exitCode = 1;
}

main();
