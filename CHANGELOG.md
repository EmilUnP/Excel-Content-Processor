# Changelog

All notable changes to Excel Content Processor are documented here.

---

## [3.4.3] — 2026-09-21

### Partial translation + question body in a variant column

Follow-up to 3.4.2 after more bad rows:

1. **Half-translated cells** — output mixed Azerbaijani with leftover Russian.
   Detection only treated `source === output` as failure, so mixed cells were
   saved as success. Now leftover Cyrillic triggers a solo retry.
2. **Question stem swapped into a variant** — question column shrunk to a short
   fragment while a variant column held the long stem (e.g. Roosevelt / New Deal
   rows). Structural length checks now flag and re-translate those cells.
3. Prompts require translating the **entire** cell and forbid swapping content
   between question and variant cells.

Audit: `npm run check:merged` also reports partial Cyrillic and swap patterns.

### Simple Russian-alphabet finish check

After every translation finishes, the app scans question/variant cells for any
Cyrillic letters. None → clean. Any found → listed as a problem (UI + server log).

Manual re-check anytime:

```bash
npm run check:russian
npm run check:russian -- data/files/your_translated_az.json
```

---

## [3.4.2] — 2026-09-21

### Question / variant cells mixed after batch translation

On a Russian→Azerbaijani run of 1000+ questions, a handful of rows came back
with answer options inside the **question** column — e.g. the question ending
in `1.` while Variant 1 lost its number, or the full `1. … 2. … 3. …` list
pasted into the question cell. Code / answer-key columns stayed correct.

**Cause:** Batches were sent as a numbered list (`1. "…"`, `2. "…"`). Question
and variant cells from the same row sit next to each other in that list, so the
model sometimes treated batch indices as multiple-choice markers and remapped
text across cells. The run still “succeeded” because only array length was
checked.

**Fix:**
1. Batch items use opaque tags `[T01]`, `[T02]`, … instead of `1.` / `2.`.
2. Prompts state each block is one independent spreadsheet cell — never merge
   or invent option lists.
3. After each batch, structural checks detect gained option markers / emptied
   variants and re-translate those cells alone.
4. Audit: `npm run check:merged` (optional path to a translated JSON file).

---

## [3.4.1] — 2026-09-18

Two defects from a real run: 1,636 questions, Russian to Azerbaijani, on a
GPT model. Both are traced below on that file, which holds 17,996 non-empty
cells.

### Options ran on inline instead of standing apart

`...mübarizə aparmışdırb) Cavanşirə...` and `...müəyyən edin:a) Ərəb...` — the
marker welded to the word or the colon in front of it, so the choices read as
one paragraph. 19 places in the file.

There is a cleanup pass that fixes exactly this, and it never ran. It was
switched on by model family:

```js
const finish = (text) => (applyGeminiCleaning ? cleanGeminiTranslation(text) : text);
```

The mistakes are not Gemini's, though — this run was a GPT model and made them
anyway. **It now runs for every model.**

Switching it on as it stood would have been worse than leaving it off. Run over
the same file it changed **116 cells**, and the changes included:

```
  birləşməsi c. Çindən   ->  birləşməsic. Çindən     a correct space, removed
  (Alptekin) sayılır     ->  (Alpteki n) sayılır     a closing bracket read as a marker
  tələb edirdi. Kişi     ->  tələb edird i. Kişi     a word ending in -i, split
  XXVI. İltəris          ->  XXV I. İltəris          a Roman numeral, split
  e.ə. IV minillik       ->  e. ə. IV minillik       an abbreviation, broken open
```

Five rules were at fault and each is fixed:

- A rule that glued **any** single letter onto the word before it — the exact
  opposite of this file's purpose, since every properly spaced `a.` `b.` `c.`
  was a target. Removed.
- Four rules matching Roman numerals case-insensitively, so `[IVX]` also matched
  a lowercase `i`, `v` or `x`. In Azerbaijani, where words ending in -i are
  everywhere, that split ordinary sentences. Now case-sensitive.
- The marker rules now skip a `)` that closes a bracket still open, and only
  accept `a` to `e`, the letters these papers use.
- The "space after a marker" rule no longer fires when the next letter carries
  its own period, so `e.ə.` stays whole.

Two rules were added for what was actually in the file: a marker welded to the
`:` or `?` that introduces it, and a numbered marker welded to the end of the
previous option (`xaqanlığı2.` → `xaqanlığı 2.`).

Over the whole file the pass now changes **21 cells, every one an improvement**,
and a 22-case test covers both what it must fix and what it must leave alone.

### The last four questions were still Russian

Confirmed: rows **1632 to 1635**, the last four in the file. 105 cells still
held Cyrillic; 61 of those were byte-identical to their source. Two causes.

**The upload corrupted the text before anything else saw it.** These workbooks
store Russian as numeric entities, and the upload ran:

```js
// "ALWAYS, as it's commonly misused for pi"
text = text.replace(/&#1087;/g, '&#960;');
```

`&#1087;` is Cyrillic **п**. So every п in every word became a Greek **π**:
`Определите` was stored as `Оπределите`, and the model was handed Russian it
could not read and handed it straight back. Across the two real files this
produced **1,686 π, every one of them a letter inside a Cyrillic word, and not
one of them maths**. The rule now needs a digit in front of it, which is the
case it was written for (`2&#1087;` → `2π`), and the two rules after it already
covered a genuine maths context.

Files uploaded before this still carry the substitution, so the repair also runs
on the way out: a π sharing a word with a Cyrillic letter is a п, a standalone
or numeric one is maths and is kept. Entities are decoded there too, and both
now happen for a text sent on its own as well as for one in a batch — that path
used to send raw `&#1050;&#1090;&#1086;` to the model.

**And when a batch came back short, the gap was filled with the input:**

```js
console.warn('Translation count mismatch:', ...);
for (let i = translations.length; i < texts.length; i++) {
  translations.push(texts[i]);        // the source, kept as the translation
}
```

A batch of 30 that ran out of output budget at 27 left three questions in
Russian, and the run reported success. Those are now **translated individually
instead**, and anything the model hands back unchanged is re-sent on its own.
A text that has already had a request of its own is not sent twice, and a
refusal stops the retries rather than repeating a dead call 30 times.

What a run had to do is now reported rather than swallowed:

```
Translation recovery: {"shortBatches":1,"retried":4,"recovered":1,"untouched":0}
```

Verified end to end against a stand-in service reproducing both failures — a
batch returning 27 of 30, and a text handed straight back. Before: 4 cells left
in Russian. After: **0**, with the three missing and the one echo each
translated on their own, the marker spacing applied on a GPT model, and the
model receiving `Кто стал первым?` where it used to receive
`&#1050;&#1090;&#1086; &#1089;&#1090;&#1072;&#1083; &#960;&#1077;...`.

---

## [3.4.0] — 2026-09-17

A second optimisation pass, this time over the image pipeline added in 3.1–3.3.
Both findings were flaws introduced by that work.

### The translated-image cache was quadratic

Every translated picture was kept in one JSON file, and that file was rewritten
in full after **each** image so nothing already paid for could be lost in a
crash. Each entry holds a full PNG — measured at **1,007 KB**. Rewriting a
growing file 128 times is not a small cost:

```
                          before            after
final cache size          126 MB            126 MB, as 128 files
total bytes written       7.93 GB           126 MB
read before a run         126 MB parsed     32 KB index parsed
writes                    128, avg 63 MB    128, one image each
```

The cache is now **one PNG per image plus a small JSON index** holding metadata
only. Pictures are loaded individually, on demand, so a cache entry that this
run does not need costs nothing to have.

**Nothing paid for was discarded.** An existing single-file cache is split into
the new layout on first use and the old file is *renamed*, not deleted. Verified
on the real cache: 3 entries migrated to 3 PNGs, index **926 bytes** (was
2.95 MB), `image-translate-cache.json.migrated` left in place, and a free
cached-only run still returned all three with `spent: 0`.

### Every image was stored twice

`imageData` was extracted *from* `original` at upload, so each picture was held
twice in the same file. Measured across the stored file: **128 of 128** image
cells had a byte-identical copy, accounting for **46%** of the file.

The duplicate is no longer written. Readers already took the picture from
`original` and only fell back to `imageData`, so nothing changes for them. Two
checks made this safe rather than hopeful:

- `.cleaned` never contains images — **0 of 1,008 cells** — so the translation
  service's image-restore path, the main consumer, was inert on real data, and
  it has a fallback that reads `original` regardless.
- The field is kept in the type, because step 3 still uses it for something real:
  when a picture is replaced by a translated one, the untouched original is
  stored there so it stays recoverable.

Verified by uploading a workbook carrying real images: 12 image cells, **0**
with a duplicate, images still readable from `original`, step 1 and step 3 both
working, and all 12 decoding in the browser at their true sizes.

Effect on a stored file: image payload falls from 92% of the bytes to 86%, and
the file itself shrinks by about 46%.

## [3.3.0] — 2026-09-17

### Translate Images — step 3

A new **Translate Images** button sends each picture to an image-generation
model and gets it back redrawn with its words in the target language. Numbers,
formulas and single-letter labels are left alone.

Verified on a real run — Russian → Azerbaijani, `google/gemini-3-pro-image`:

```
"Шампиньон"  ->  "Şampinyon"
```

The Venn diagram came back with all five circles, both `+` signs, the `−`, and
the K / L / M / F labels untouched — those are variables, not words.

**What this step cannot do, and why.** The request was to change only the text
and leave the rest byte-for-byte. No current model works that way: an editing
model regenerates the entire picture from the original plus an instruction. The
diagram is *reproduced*, faithfully, not *preserved*. On the cheaper Flash model
one test clipped a circle at the right edge; the Pro model did not. The
before/after images are worth a glance on the first few before committing to a
whole file.

**Display size is preserved even though pixel size is not.** The model returns
its own canvas — 288×248 came back as 1120×960. Rather than downscale and blur
the new text, the `<img>` carries explicit `width`/`height` from the original:

```html
<img src="data:…" width="288" height="248" data-translated="1">
```

Layouts and exports are therefore unchanged, while the stored pixels are sharper
than the original — better for print. The untouched original stays in the cell's
`imageData`, so nothing is lost.

### Cost is the defining constraint

Measured, one real call each on the same 288×248 diagram:

| Model | Per image | 67 images | Note |
|---|---|---|---|
| `google/gemini-3-pro-image` | **$0.139** | ~$9.32 | Best fidelity, nothing clipped |
| `openai/gpt-5.4-image-2` | ~$0.05 est. | ~$3.35 | OpenAI alternative |
| `google/gemini-2.5-flash-image` | **$0.039** | ~$2.60 | Cheapest, can crop edges |

(`openai/gpt-image-2` is not on OpenRouter; `gpt-5.4-image-2` is the nearest.)

Three things follow from that, and they shaped the design:

- **A cost estimate appears before anything runs**, and the running total is
  shown as it is spent — not only at the end.
- **"How many" defaults to the first 3 images**, so quality can be judged for
  about 40 cents before committing to a nine-dollar run.
- **Images are translated one at a time, not in parallel.** Concurrency would
  only multiply the damage of a wrong language or model before anyone could
  stop it.

**Every image is redrawn once, ever.** Results are cached in
`data/image-translate-cache.json`, keyed by image bytes + target language +
model, and written after *each* image so a stop or a crash never discards work
that has been paid for.

Verified end to end on a 42-question copy: 3 of 54 images translated, 51 skipped
by the limit, 3 cells updated, **$0.4182** spent — matching the per-image figure
above — original `imageData` retained, and the cache holding all three results.

New: `POST /api/files/translate-images` (NDJSON progress, like step 2),
`lib/image-translate-service.ts`, `lib/image-translate-cache.ts`.

### Models are configured in .env

Every model the app offers now comes from `.env`. They used to be hardcoded in
four places - the picker component, a mapping table and two service files - so
adding one meant four edits and a rebuild. Now it is one line and a restart:

```
TRANSLATION_MODELS=openai/gpt-4o-mini|GPT-4o Mini,google/gemini-2.5-pro|Gemini 2.5 Pro
TRANSLATION_MODEL_DEFAULT=openai/gpt-4o-mini
IMAGE_TEXT_MODEL=openai/gpt-4o-mini
IMAGE_TRANSLATE_MODELS=google/gemini-3-pro-image|Gemini 3 Pro Image|0.139
IMAGE_TRANSLATE_MODEL_DEFAULT=google/gemini-3-pro-image
```

The label after `|` is optional - without it the name is derived from the id -
and the provider ("OpenAI", "Google") comes from the id's owner prefix. The
lists are read per request and served by `/api/provider`, so no rebuild is
needed, and the defaults are validated against the list: naming a default that
is not in it falls back to the first entry rather than breaking silently.

The AI Model panel lost its hand-written blurbs and feature bullets. They were
maintenance for their own sake and had already gone stale; each card now shows
the name, the provider, the exact model id and which one is the default.

### Images are visible in the table

The table only ever showed an "Images" badge - the pictures themselves were
invisible until you exported. That made it impossible to check the result of an
image translation without downloading a file first.

Cells now render their pictures as thumbnails, capped in height, lazy-loaded,
and clickable to open full size. A translated image is outlined in rose and
carries a small badge, so a redrawn one can be told from an untouched one at a
glance. Verified on the real file: **128 images rendered, 3 marked as translated**.

### Seeing what you already paid for, for free

"How many" gained **"Already translated only — free"**. It builds a viewable
file from images that have already been redrawn into this language with this
model, making **no API calls at all**.

This existed because translated images were being stored in
`data/image-translate-cache.json` where the app could not show them - if the
output file was lost, so was any way to look at work that had been paid for.
Verified: rebuilt a 72-row file with 3 translated images, `spent: 0`.

---

## [3.2.0] — 2026-09-17

### Images With Text — step 2 of the image pipeline

A new **Images With Text** button. Step 1 (`Only Images`) narrowed a file to the
questions that have pictures at all, using flags computed at upload. This step
looks *inside* each picture with a vision model and keeps only the questions
whose images contain words — the ones a future version will be able to translate.

A diagram labelled `1 2 3 4`, a chemistry formula or an axis marked `V_a` has
nothing to translate, so those questions are removed even though they do have
images. A diagram labelled `Растения / Корень / Стебель / Лист` stays.

**This is the first feature that calls a model.** One request per distinct
image, through OpenRouter, using whichever model is selected in the AI Model
panel. All five models in the picker accept image input and JSON mode — checked
against OpenRouter's live model list before wiring it up.

The classifier answers one of three kinds:

| Kind | Meaning | Question kept? |
|---|---|---|
| `words` | at least one real word, in any language or script | yes |
| `numeric` | only digits, formulas, units or single-letter labels | no |
| `none` | no readable text at all | no |

**Every image is paid for once, ever.** Results are cached in
`data/image-text-cache.json`, keyed by a hash of the image bytes plus the model
name. The same picture re-analysed in another file, or after a re-upload, is
free. The model is part of the key, so switching models re-analyses rather than
trusting an older verdict.

An image the model cannot read is treated as having no text — it is better to
drop a doubtful question than to claim it is translatable.

**Validated against the real model** (`openai/gpt-5-nano`, 8 images):

```
bio-ru-00932   ->  words     "Шампиньон"
bio-ru-00933   ->  words     "шампиньон бледная поганка"
bio-ru-00938   ->  words     "Характерный признак живого организма"
bio-ru-01895   ->  words     "Растения Корень Стебель Лист"
bio-ru-01923   ->  words     "Цветки сложного початка кукурузы"
bio-ru-02861   ->  numeric   "v(H2O) v(N2) t"
bio-ru-02869   ->  numeric   "V_a, V_{n,n}"
bio-ru-00034   ->  none      ""
```

Cyrillic labels are read accurately and chemistry/algebra images are correctly
rejected. The boundary between `numeric` and `none` is occasionally arbitrary —
a diagram labelled only `1 2 3 4` may come back as either — but both mean
"remove", so the outcome is unaffected.

The full pipeline was also exercised against a mock endpoint that asserts the
request shape: 128 distinct images, no duplicate sends, correct OpenRouter model
id, `temperature: 0`, `response_format: json_object`, and a data URL in every
request. A second run made **zero** API calls and returned an identical result.
The kept set was independently recomputed from the cache and matched exactly —
31 of 72, with no kept question lacking a words-image, IDs in order, and rows
re-numbered 0..n-1.

New: `POST /api/files/image-text`, `lib/image-text-service.ts` (the prompt and
the vision call) and `lib/image-text-cache.ts` (content-addressed cache).
`IMAGE_ANALYSIS_CONCURRENCY` controls how many images are in flight (default 4).

**Next version:** translate the text found inside these images.

### Progress, in-app dialogs and a clearer toolbar

The two filter actions used the browser's native `confirm()` and `alert()`.
Those render as the browser's own chrome rather than the app's, block the page,
and cannot show progress — so a two-minute image analysis looked like a freeze.
Both now run through one in-app dialog that shows the plan, then live progress,
then the result.

**Real progress, not a spinner.** `POST /api/files/image-text` returns a stream
of newline-delimited JSON instead of a single object at the end:

```
{"type":"start","total":128,"cached":40,"model":"gpt-5-nano"}
{"type":"progress","done":41,"total":128}
{"type":"done","data":{...},"stats":{...}}
```

The dialog reads it and fills a bar: *"Reading image 74 of 128 — 73/128 (57%)"*.
Events are throttled to about one per 150 ms so a large file cannot flood the
stream, and cached images resolve instantly at the start rather than being
re-counted. Problems detectable before any work starts (missing file id,
missing API key) stay ordinary JSON errors with a status code, so a plain client
still sees them.

**The toolbar now separates doing from downloading**, which was the real source
of confusion — one group rewrites your file, the other just saves a copy:

```
[Cleaned] [Original] │ FILTER FILE [Only Images 31] [Images With Text AI] │ DOWNLOAD [Excel + HTML] [Export to HTML]
Rows per page [100]   31 questions · 14 columns · 434 cells · 31 with images · 78 images
```

The summary line replaces the bare *"31 rows × 14 columns"* and now answers what
the open file actually holds, including how many questions carry pictures and
how many pictures there are in total.

Also: `IMAGE_TEXT_CACHE_PATH` overrides where verdicts are cached, so a test run
can use a scratch file instead of discarding real, already-paid-for results.

**Verified:** the dialog opens with the plan and no native popup fires
(`window.confirm` and `window.alert` were stubbed and never called); the bar
moves 0% → 57% → 100% with the width tracking the count; the result panel shows
the breakdown and a Close button; and the dialog refuses to close while a job is
running.

### Language filter on image text

The classifier now also reports **which language** the words in an image are in,
and the filter can require a specific one. Words in a language you are not
translating into are no more useful than no words at all, so an image labelled
in Azerbaijani is dropped from a Russian run just like a blank diagram is.

The confirm dialog gained a **"Keep text in"** picker — Russian, Azerbaijani,
English, Turkish, or *Any language*. It defaults to Russian, which is what these
papers are written in. The result panel reports how many of the words-images
were in the target language, and lists the others (*"also: az 3, en 1"*), so a
surprising result is explainable rather than mysterious.

The judgement is made on the words, not the alphabet: Azerbaijani and Turkish
both use Latin script, so script alone would not separate them.

Cache entries written before this change carry a kind but no language. Rather
than discard them, `readEntry` treats one as a miss **only** when the current
run actually filters by language — so an "Any language" run still uses them, and
a Russian run re-reads just those images.

### A more useful summary line

The toolbar summary read `46 questions · 14 columns · 644 cells · 46 with images
· 67 images`. On a file that has already been filtered, "46 questions" and "46
with images" are the same number twice. It now adapts:

```
all have images   46 questions with images · 67 images in total · 14 columns · 644 cells
mixed             72 questions · 36 with images · 70 images in total · …
none              72 questions · no images · …
```

The image facts are violet and lead; the file's shape is grey and trails.

### File names no longer overlap

Long names in the file manager spilled across neighbouring cards. The row was a
flex container without `min-w-0`, so it refused to shrink below its text and
`truncate` never took effect. Names now wrap to two lines, with the full name on
hover.

Wrapping rather than truncating is deliberate: the part that tells these files
apart — *"(images only)"*, *"(images with text)"* — sits at the **end** of the
name, which is exactly what truncation would have cut.

---

## [3.1.0] — 2026-09-17

### Only Images

A new **Only Images** button in the table toolbar. It is an *action on the data*,
not an export: it scans every question in the open file, removes the ones with
no picture anywhere, and writes the result back to `data/files/` as JSON. The
app then switches to the filtered file.

**No AI is used.** Every cell already carries a `hasImages` flag, worked out
when the file is uploaded. This only groups those cells back into whole
questions and drops the rest — the first, deterministic step of the larger
analysis plan, not a model call.

An image can sit in the question, in the answer variants, or in both in the same
question. All three count, and the confirmation dialog shows the split before
anything is written.

**The original file is never modified.** The result is saved beside it as
`<fileId>_images` and appears in the file manager as its own entry, so the full
set is always one click away.

Kept rows are re-numbered 0..n-1. Leaving the original row indexes would make
the table build a 2,154-row grid with 72 rows filled in; the ID and ID-Q columns
still identify every question.

The button carries the count, and disables itself when there is nothing to
remove — either the file has no images at all, or every question in it already
has one (which is the case right after the action has run).

**Measured on `Olimpiada_new_phase_BIO.xlsx`:**

```
                       before            after
questions               2,154               72
cells                  30,156            1,008
stored JSON            10.6 MB          3.44 MB
images                    128              128   <- none lost

breakdown   54 image in the question
            16 image in the variants
             2 image in both
         2,082 removed
```

Verified end to end in the app: the header goes from
*2,154 rows · 14 columns · 30,156 cells* to *72 rows · 14 columns · 1,008 cells*,
the title becomes *"… (images only)"*, pagination collapses to a single page,
every one of the 72 remaining rows carries an Images badge, the original file is
still listed untouched, and the button then reports nothing left to remove.

New API route `POST /api/files/images`, and a new module
`lib/question-model.ts` holding the column layout (ID, ID-Q, Question,
Variant N / Code N), which column is a code column, which variant is correct,
and the image scan. `isCodeColumn` was previously duplicated in two components
and now lives here once.

---

## [3.0.0] — 2026-09-17

**A performance release, plus CSV input, a provider move and a cleanup.**
No translation prompt was touched and no cleaning rule was changed. Every
optimisation below was checked to produce *the same output* as before — only
faster. On top of that: CSV/TSV upload, all models moved to OpenRouter, the
Analysis, Clean File and Settings features removed, and a pass over the codebase
to delete everything that was not doing any work.

Reference dataset used for all measurements: `kimya - 854.xlsx`
— 854 rows × 15 columns = **12,810 cells**, 14 MB stored as JSON,
**3,955** of those cells translatable.

---

### Where we were (v2.0)

The app worked, but it spent most of its time waiting on things that did not
need waiting on:

1. **Translation ran strictly one batch at a time.** With Gemini's batch size of
   10, translating the reference file meant 396 API round trips, each one
   starting only after the previous had fully returned. The API spends most of
   that time idle on the network — nothing was overlapping.
2. **The browser re-uploaded data the server already had.** Starting a
   translation serialised every translatable cell (text, HTML, image data) into
   the request body and posted **10.36 MB** to a server that already had the
   exact same file sitting on disk.
3. **Re-assembling the translated file was O(n²).** For each of the 12,810
   original cells it ran a linear `.find()` across ~4,000 translated cells —
   roughly 50 million comparisons per translation, single-threaded, blocking.
4. **Listing files fully parsed every file.** Opening the file manager read and
   `JSON.parse`d each 14 MB file end-to-end, one after another, just to display
   a name, a date and three numbers.
5. **The same file was re-read and re-parsed constantly** — on page load, before
   translating, before cleaning, and again on every refresh.
6. **The table mounted all 854 rows at once.** ~10,000 cells, each with nested
   markup and badges, built in a single blocking commit. Any state change — even
   one keystroke in one cell — re-rendered all of them.
7. **`Math.max(...array)` over 12,810 cells.** It worked at this size, but it
   spreads every element as a function argument and throws `RangeError` on a
   large enough file.
8. **A `console.log` per filtered cell** fired thousands of times before a
   translation request was even sent.

### What we changed

| # | Change | File |
|---|---|---|
| 1 | Batches now run through a bounded worker pool instead of a sequential loop. Results are written back by batch index, so ordering is unchanged. Defaults: 4 in flight for Gemini models; override with `TRANSLATION_CONCURRENCY`. | `lib/translation-service.ts` |
| 2 | The client sends only `{rowIndex, colIndex}` pairs; the server resolves cells from its own copy. The old `cellsToTranslate` payload is still accepted. | `components/TranslationPanel.tsx`, `api/translate/route.ts` |
| 3 | The per-cell `.find()` was replaced with a `Map` index built once. | `api/translate/route.ts` |
| 4 | The listing reads metadata from the JSON header and counts cells by scanning raw bytes — no `JSON.parse` at all. Files are read in parallel and cached by mtime + size. | `api/files/route.ts` |
| 5 | `FileStorage.getFile` gained a 2-entry, mtime-validated cache, dropped on save and delete. | `lib/file-storage.ts` |
| 6 | Cell helpers moved to module scope, rows wrapped in `React.memo`, and the table is paginated (default 100 rows/page) so the DOM stays a constant size. Large pages still fill progressively. | `components/DataTable.tsx` |
| 7 | Replaced with single-pass loops. | `components/DataTable.tsx` |
| 8 | Removed the per-cell log; server progress logs throttled to ~10% steps. | `components/TranslationPanel.tsx`, `api/translate/route.ts` |
| 9 | Compile target raised from `es5` to `es2020` — less down-levelling, smaller and faster output. | `tsconfig.json` |
| 10 | `/api/files` marked `force-dynamic` so a production build cannot serve a frozen file list. | `api/files/route.ts` |

### What we get now

```
Translation pool       4.0x faster at concurrency 4
                       5.7x faster at concurrency 6
                       output byte-identical to sequential, progress monotonic

Translate payload      10.36 MB  ->  0.11 MB      (-98.9%)
                       29 ms     ->  1 ms         (client-side serialisation)

File list endpoint     2.88 s    ->  0.039 s      (warm, cached)
Cell counting          44 ms     ->  12 ms        (byte scan vs JSON.parse)

Table DOM              10,245 cells  ->  ~1,200 cells  (one 100-row page)
                       constant from here on, whatever the file size
Export coverage        855 <tr> exported while 100 rows were on screen
```

**Not benchmarked:** the table's render timing in milliseconds. The measurement
environment throttled `requestAnimationFrame`, so any number would have been
meaningless. That improvement is structural — an order of magnitude fewer DOM
nodes, plus memoised rows — and every behaviour was verified correct.

---

### Codebase cleanup

A pass to remove everything that was not doing any work, so what remains is only
code that actually runs.

**The Settings panel was a facade.** An audit of which settings the app ever
*reads* found exactly one: `settings.selectedModel`, and that is set from the
separate AI Model panel. Batch size, max concurrency, preserve formatting,
extract images, clean HTML, detect language, export format, include metadata and
a second API key were all editable in the UI and consumed by nothing. The panel
and those fields were removed rather than left implying they did something.
`AppSettings` is now a single field.

**Two mount-only effects in `page.tsx` were dead.** One re-verified that
`currentFile` still existed on the server; `currentFile` is not persisted, so on
mount it is always null and the body never ran. The other reset processing state
that already starts idle. Removing them also cleared the last two lint warnings —
the build is now warning-free.

**`showAllColumns` was fake state.** Its setter was never called, so it had
always been `false`. It is now an explicit `SHOW_ALL_COLUMNS` constant carrying
the note about the column-shift behaviour, instead of a `useState` pretending to
be adjustable.

Removed as unused:

| Area | Removed |
|---|---|
| Dependencies | `@radix-ui/react-dialog`, `@radix-ui/react-progress`, `cheerio`, `exceljs`, `sharp`, `@types/xlsx` (xlsx ships its own types) — **176 packages** |
| Store | `files` + its three actions, `setUI`, `resetUI`, `reset`, `setDefaultLanguage`, `setSettings`, `translationProgress` + setter, `openaiApiKey` + setter |
| Types | `TranslationResult`, `TranslationProgress`, and eight `AppSettings` fields |
| `translation-service` | `getSupportedLanguages`, `getLanguageName` — 40-language tables, while the UI offers four |
| `file-storage` | `listFiles`, `cleanup` — no callers |
| `ai-provider` | `requireOpenRouterApiKey`, `getProviderStatus` — no callers |
| `excel-processor` | `containsBase64Data` — never called |
| `FileUpload` | `acceptedTypes` prop (declared, defaulted, never read), `dragActive` state |
| Imports | dead icons and types in six files |
| Locals | `originalInput`, `listSpan`, `firstMarker`, `lastMarker` |
| Root files | `env.example` (duplicate of `.env.example`, listing DB/Redis/NextAuth vars the app never reads), `tsconfig.tsbuildinfo` (build artifact, now gitignored) |

`next.config.js` lost `serverRuntimeConfig` and `publicRuntimeConfig` (App
Router ignores both), `images.domains` (deprecated, and `next/image` is unused)
and `swcMinify` (the default in Next 14).

**Guard against regression:** `noUnusedLocals` is now on in `tsconfig.json`, so
a dead import or variable fails the build. It is deliberately *not* paired with
`noUnusedParameters` — regex callbacks like `(match, group) => ...` legitimately
ignore their first argument, and that rule would flag every one of them.

```
build warnings   2  ->  0
dependencies     26 -> 20   (176 packages removed from node_modules)
first load JS    145 kB -> 142 kB
store surface    23 actions/fields -> 10
AppSettings      13 fields -> 1
```

**Verified after the cleanup:** file loads, table renders 100 rows with working
pagination, model selection persists (and the stored blob is now just
`{"settings":{"selectedModel":"…"}}`), and "Export to HTML" still emits 855
`<tr>` / 6.5 MB — unchanged.

### OpenRouter is now the only AI provider

All translation goes through **OpenRouter**. The direct OpenAI and Google AI
Studio paths were removed outright — not kept as a fallback. One key, one
account, one bill.

**The model list is unchanged.** The same five options appear in the picker and
behave the same; only the id sent over the wire differs:

| Model in the app | Sent to OpenRouter as |
|---|---|
| Gemini 3 Flash | `google/gemini-3-flash-preview` |
| Gemini 2.5 Flash | `google/gemini-2.5-flash` |
| Gemini 2.5 Pro | `google/gemini-2.5-pro` |

Every id was checked against OpenRouter's live model list before being written
down, and all five support `response_format`, so the existing JSON-mode prompt
works unchanged.

**The one subtlety worth recording.** Model *family* and *provider* are separate
ideas. Gemini models make a characteristic spacing mistake, and the old code
fixed it in the Google-SDK branch. Routing Gemini through an OpenAI-compatible
endpoint would have quietly dropped that cleanup — same model, same defect, no
longer corrected. `translateBatch` therefore takes an `applyGeminiCleaning`
flag, set from the model family rather than from the transport.

Verified against a mock OpenRouter endpoint, with a response deliberately
containing a defect the cleaner is known to fix:

```
app model: gemini-2.5-flash
  model sent        google/gemini-2.5-flash
  translated cell   "Answer 3? I. Alpha II. Beta"    <- cleaned (Gemini family)

both:  Authorization: Bearer sk-or-...  |  HTTP-Referer + X-Title sent
       response_format: {"type":"json_object"}  |  original field preserved
```

New and changed:

- `lib/ai-provider.ts` (new) — model id mapping, key lookup, attribution
  headers. `OPENROUTER_MODEL_MAP` overrides any id without a code change;
  `OPENROUTER_BASE_URL` points the app at a compatible gateway or proxy.
- `api/provider` (new) — reports whether a key is configured. Returns a boolean
  and a label, never key material.
- The **AI Model** panel shows the live provider, and warns in red
  (*"OpenRouter - no API key configured"*) before a translation can fail.
- `@google/generative-ai` removed from dependencies; roughly 600 lines of
  Google-SDK translation code deleted.
- Missing key now produces one clear message instead of a provider-specific
  guess: *"OPENROUTER_API_KEY is not set. Add it to your .env file…"*

### Clean File feature removed

The **Clean File** button and everything behind it are gone: the toolbar button,
`handleCleanFile`, the `isCleaning` state, and the `api/files/clean` route.

Two props existed only to serve it and went with it — `fileId` and
`onDataRefresh` (the post-clean reload in `page.tsx`). `DataTable` now takes
just `data`, `editable` and `showMetadata`.

`lib/text-cleaning.ts` **stays**. Its `cleanGeminiTranslationErrors` is still
called by the translation service to fix Gemini's spacing mistakes as
translations come back — that is a different job from the manual pass over a
stored file, and removing it would have silently degraded Gemini output.

Also cleared out while in there: `DataTable` imported
`cleanGeminiTranslationErrors` but never called it — a dead import that predates
this change.

**Verified:** the button is gone from the toolbar, which now reads
*Cleaned · Original · Excel + HTML · Export to HTML*; `POST /api/files/clean` no
longer resolves; and exports are unaffected — with 100 rows on screen,
"Export to HTML" still produced 855 `<tr>` and 6.5 MB, unchanged from before the
removal.

### Analysis feature removed

The Analyze button and everything behind it are gone: the header button,
`AnalysisPanel`, `api/analyze`, `analysis-service.ts`, the `AnalysisResult`
type, the `currentAnalysis` / `showAnalysis` store state, the three
`FileStorage` analysis methods, and the `data/analysis/` directory. The header
is now **Translate · Files · AI Model · Settings**.

### Table pagination

The remaining table cost was simply the number of cells in the DOM, and it grew
with the file. Progressive rendering fixed the *blocking* first paint but the
finished table still held every row, so scrolling a large file stayed heavy.

The table now renders **one page at a time**, which makes the DOM a constant
size regardless of how many rows the file has:

| File | Rows in the DOM before | after (default 100/page) |
|---|---|---|
| 854 rows × 15 cols | 10,245 cells | ~1,200 cells |
| 5,000 rows × 15 cols | ~60,000 cells | ~1,200 cells |

- **Rows per page**: 50, 100 (default), 250, 500, or All. Stored in
  `localStorage`, wrapped in try/catch so a private window or blocked storage
  falls back to the default instead of throwing.
- **Row numbers stay absolute.** The row component receives
  `pageStart + indexOnPage`, so row 201 is labelled 201 on page 3, and the edit
  and delete callbacks address the right cell in the file. Verified: the edit
  control on page 3 reports *"Edit row 201, column 2"*.
- **Page state is clamped, not corrected.** Loading a smaller file cannot strand
  the view on a page that no longer exists, and opening a different file returns
  to page 1.
- **Changing page scrolls back to the top** of the table while preserving the
  horizontal scroll position.
- The pagination bar sits **above** the table. Below it, the 70vh table pushed
  it off-screen on every normal display, so paging meant scrolling the page
  first.
- Progressive filling now only applies to pages larger than 250 rows. At 100
  rows per page it added a visible 60-then-100 two-step for no benefit, since
  pagination already keeps the commit small.

**Exports are unaffected by the current page.** Both export paths read
`tableData`, never the page slice. Verified at runtime: with 100 rows in the
DOM, "Export to HTML" produced 855 `<tr>` elements (854 data rows plus the
header) and 6.5 MB of output.

**Verified:** page 1 rows 1–100; page 2 rows 101–200 complete on arrival; last
page 801–854 (partial); first/previous disabled on page 1 and next/last disabled
on page 9; switching to 250 resets to page 1 and persists; "All" renders all 854
rows and hides the navigation; the choice survives a reload.

### CSV / TSV upload

`.csv` and `.tsv` files can now be uploaded alongside `.xlsx` and `.xls`.

A CSV declares neither its encoding nor its delimiter, so both are worked out
from the file itself (`lib/excel-processor.ts`):

- **Encoding** — a byte order mark (UTF-8, UTF-16LE, UTF-16BE) is honoured
  directly. Without one the file is decoded as UTF-8 with a *strict* decoder;
  when that rejects the bytes the file is re-decoded as Windows-1251, which is
  the usual shape of a Cyrillic CSV exported from Excel.
- **Delimiter** — comma, semicolon, tab and pipe are counted across the first
  few rows, ignoring anything inside quotes, and the one that appears
  consistently on every row wins. Excel writes semicolons in any locale where
  the comma is the decimal separator, so assuming "comma" is wrong often enough
  to matter.
- **`raw: true`** — values are kept exactly as written and never re-typed.

> **Why `raw: true` is not optional.** Left to type-guess, SheetJS parses an
> 18-digit question ID as a float. `250112373304203237` exceeds the exact
> integer range of a double and comes back as `250112373304203230` — the last
> digit silently changed. Verified against both settings before shipping.

Alongside it:

- Upload validation now keys on the **file extension** rather than the
  browser-reported MIME type. Windows reports `.csv` as
  `application/vnd.ms-excel`, Chrome as `text/csv`, and some systems send a
  blank type for a perfectly good `.xlsx` — all three used to be rejected.
- A file with no data rows is refused with *"The file appears to be empty"*
  instead of being stored as a useless one-cell entry.
- Upload errors now reach the user. The client threw on `response.statusText`
  before reading the body, so a rejected file showed *"Upload failed: Bad
  Request"* instead of the server's actual explanation. Bad input also returns
  **400** now rather than 500.
- Upload copy updated: *"Upload Spreadsheet"*, supported formats, and a note
  that CSV encoding and delimiter are detected automatically.

**Verified:** UTF-8, UTF-8 + BOM, semicolon-delimited (with a comma inside a
quoted field), Windows-1251 Cyrillic without BOM, and tab-separated `.tsv` —
all parsed with the 18-digit ID exact and Cyrillic intact; accepted under three
different reported MIME types including a blank one; `.docx` still rejected;
empty file refused with 400; real `.xlsx` upload unchanged; and a genuine
drag-and-drop through the browser confirmed end to end.

### UI / UX

- Version bumped to **3.0** across the header, page title, metadata and config.
- **`Esc` closes any open panel** — Translation, Settings, Model and Files —
  via a shared `useEscapeToClose` hook.
- **Inline cell editing gained keys**: `Enter` saves, `Esc` cancels. Both
  buttons now carry tooltips.
- **Zebra striping** on table rows, so your eye keeps its place across 15
  columns, plus a clearer sticky row-number column.
- **Edit / clear buttons** now have hover colours (blue / red), tooltips and
  screen-reader labels.
- **Pagination controls**: rows-per-page selector and first/previous/next/last
  navigation with a *"Showing rows 1–100 of 854"* summary, placed above the
  table so they are reachable without scrolling.
- **Row-fill indicator**: when a page is large enough to fill progressively
  (the "All" option), a *"Loading rows…"* marker appears so a partly-drawn
  table is never mistaken for a truncated one.
- **Thousands separators** on row / column / cell counts (`12,810` not `12810`).
- Fixed the `jsx-a11y/alt-text` lint warning by aliasing the Lucide `Image` icon.

### Documentation

- `README.md` updated to v3.0: performance table, Gemini setup, the
  `TRANSLATION_CONCURRENCY` knob, the full endpoint list, keyboard shortcuts,
  and a note about `run-app.bat` / production builds.
- This changelog added.

---

### Known / deferred

- **Translation progress is still coarse.** The UI advances 10% → 70% → 90% →
  100% around a single blocking POST; it does not reflect real per-batch
  progress. Showing true progress needs a streaming endpoint.
- **Empty cells are skipped rather than rendered** (`DataTable.tsx`, the
  `isEmpty && !showAllColumns` branch). Harmless on the reference file — all 854
  rows were checked and every empty cell is trailing — but a file with a gap in
  the middle of a row would display its columns shifted left.
- **`run-app.bat` still starts `next dev`.** A production build is meaningfully
  faster for daily use; the launcher was left alone deliberately.
- **CSV is input only.** Export still produces Excel + HTML or a standalone HTML
  page; there is no CSV export. Worth adding if you need a round trip.
- **Only the first sheet is read**, for CSV and for Excel alike — unchanged from
  v2.0, but worth stating now that more input formats are accepted.
- **The old OpenAI and Gemini keys should be rotated.** They were committed in
  plain text in `.env.example` (now placeholders) and are no longer used by the
  app. Treat them as exposed and revoke them at the provider.

---

## [2.0.0]

- File-based storage (no database required).
- AI-powered content analysis with quality scoring and issue detection
  *(removed in 3.0)*.
- Multi-language translation via OpenAI and Google Gemini.
- HTML entity, math-expression and image handling.
- Manual "Clean File" pass over a stored file *(removed in 3.0 - the same
  cleaning still runs automatically on Gemini output during translation)*.
- Excel + HTML and standalone HTML export.
- Next.js 14 App Router, TypeScript, TailwindCSS, Zustand.
