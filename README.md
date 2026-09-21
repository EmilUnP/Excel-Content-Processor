# Excel Content Processor v3.4.3 - Simple File-Based Version

A modern, AI-powered Excel content processor that transforms complex HTML-encoded data into clean, readable content. This version uses simple file-based storage instead of a database for easy setup and deployment.

> **v3.0** adds CSV/TSV upload on top of a large performance pass - same features,
> same output, significantly less waiting.
> See [CHANGELOG.md](CHANGELOG.md) for the before/after numbers.

## ✨ Features

- **Excel and CSV Input**: `.xlsx`, `.xls`, `.csv` and `.tsv`, with encoding and delimiter detected automatically
- **File-Based Storage**: No database required - uses simple JSON files
- **Multi-Language Translation**: Gemini 2.5/3 models, all served through OpenRouter with a single API key
- **HTML Content Processing**: Clean and decode HTML entities, math expressions and images
- **Modern UI**: Built with Next.js 14, TypeScript, and TailwindCSS
- **Real-time Processing**: Live progress tracking and status updates
- **Export Capabilities**: Export to Excel (with HTML) or to a standalone HTML page

## ⚡ Performance (new in v3.0)

| Area | v2.0 | v3.0 |
|---|---|---|
| Translation API calls | one batch at a time | 4-6 batches in parallel (**4.0-5.7x faster**) |
| Translate request body | 10.36 MB | 0.11 MB (**-98.9%**) |
| Translation re-assembly | O(n²) scan | O(n) map lookup |
| File list endpoint | full JSON parse of every file | header read + byte scan, cached (**~70x faster warm**) |
| Repeated file reads | re-parsed every request | mtime-validated cache |
| Rows in the DOM | every row in the file | **one page** (default 100) — constant, whatever the file size |
| Table re-render | every cell re-rendered | memoised rows, only what changed |

Tuning knob: set `TRANSLATION_CONCURRENCY` in `.env` if your API plan allows more
(or fewer) parallel requests. Defaults are 4 for Gemini models.

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ 
- npm 8+
- An OpenRouter API key ([openrouter.ai/keys](https://openrouter.ai/keys))

### Installation

1. **Install dependencies:**
```bash
npm install
```

2. **Set up environment variables:**
```bash
cp .env.example .env
```

Edit `.env` and add your OpenRouter key. One key serves every model in the app:
```env
OPENROUTER_API_KEY=your_openrouter_api_key_here
```

3. **Start the development server:**
```bash
npm run dev
```

4. **Open your browser:**
Navigate to `http://localhost:3000`

**On Windows** you can instead double-click `run-app.bat`, which installs
dependencies if needed and serves the app on `http://localhost:3010`.

> For day-to-day use a production build (`npm run build && npm run start`) is
> noticeably faster than `npm run dev`, which recompiles on every request.

### Checks

```bash
npm run type-check   # TypeScript
npm run lint         # ESLint
npm run check:text   # the spacing cleanup, against real text
```

`check:text` is worth knowing about if you ever edit `src/lib/text-cleaning.ts`.
That file is about thirty overlapping regular expressions and a wrong one does
not throw - it quietly damages a few thousand cells. The script pins both halves
of the job: the spacing it must fix, and the correct text it must leave alone.

## 📁 Project Structure

```
src/
├── app/                    # Next.js App Router
│   ├── api/               # API routes
│   │   ├── files/         # File operations
│   │   ├── provider/      # Which AI provider is configured
│   │   └── translate/     # Translation endpoint
│   ├── globals.css        # Global styles
│   ├── layout.tsx         # Root layout
│   └── page.tsx           # Main page
├── components/            # React components
│   ├── ui/               # Shadcn/ui components
│   ├── DataTable.tsx     # Data display table
│   ├── TranslationPanel.tsx # Translation modal
│   └── ...
├── lib/                  # Utilities and services
│   ├── file-storage.ts   # File-based storage system
│   ├── excel-processor.ts # Excel processing logic
│   ├── translation-service.ts # Translation service
│   └── ai-provider.ts    # OpenRouter routing and model id mapping
│   ├── question-model.ts # Column layout + image analysis
├── hooks/                # Shared React hooks
│   └── useEscapeToClose.ts # Esc closes any open panel
├── store/                # State management
│   └── useAppStore.ts    # Zustand store
└── types/                # TypeScript types
    └── index.ts          # Type definitions
```

## 📥 Supported input formats

| Format | Notes |
|---|---|
| `.xlsx` | Excel workbook — the first sheet is read |
| `.xls` | Legacy Excel workbook |
| `.csv` | Delimiter and text encoding detected automatically |
| `.tsv` | Tab-separated text |

### How CSV detection works

A CSV carries no encoding or delimiter declaration, so both are worked out from
the file itself:

- **Encoding** — a byte order mark (UTF-8, UTF-16LE, UTF-16BE) settles it
  outright. Without one the file is decoded as UTF-8 using a strict decoder;
  if that rejects the bytes, the file is re-decoded as **Windows-1251**, which
  is how Cyrillic CSVs exported from Excel normally look.
- **Delimiter** — comma, semicolon, tab and pipe are each counted across the
  first few rows, ignoring anything inside quotes. The one that appears
  consistently on every row wins. This matters because Excel writes
  **semicolons** in locales where the comma is the decimal separator.
- **Values are never re-typed.** Every field is kept exactly as written. This is
  deliberate: an 18-digit question ID such as `250112373304203237` exceeds the
  exact range of a double, and letting the parser treat it as a number turns it
  into `250112373304203230` — a silent, unrecoverable corruption.

A file that contains no data rows is refused with a clear message rather than
being stored as an empty entry.

## 🗂️ File Storage

The application uses a simple file-based storage system:

- **Files are stored in**: `data/files/` directory
- **Format**: JSON files with structured data
- **Automatic cleanup**: Files are automatically managed

### Data Structure

```typescript
interface FileData {
  id: string;
  name: string;
  uploadDate: string;
  totalRows: number;
  totalColumns: number;
  cells: CellData[];
}

interface CellData {
  rowIndex: number;
  colIndex: number;
  original: string;
  cleaned: string;
  hasHtml: boolean;
  hasEntities: boolean;
  hasImages: boolean;
  isEmpty: boolean;
  paragraphCount: number;
}
```

## 🔧 API Endpoints

### File Operations
- `GET /api/files` - List stored files (metadata only, cached)
- `POST /api/files/upload` - Upload and process Excel file
- `POST /api/files/images` - Keep only the questions containing images
- `POST /api/files/image-text` - Keep only the questions whose images contain text (uses AI)
- `POST /api/files/translate-images` - Redraw images with their text translated (uses AI, costs money)
- `GET /api/files/[id]` - Get file data
- `DELETE /api/files/[id]` - Delete file

### Provider
- `GET /api/provider` - Reports whether an OpenRouter key is configured

### Translation
- `POST /api/translate` - Translate file content

## 🎯 Usage

1. **Upload File**: Drag and drop an Excel or CSV file, or click to browse
2. **View Data**: See your data in a clean, organized table
3. **Translate**: Select a language and translate your content
4. **Only Images**: Strip the file down to just the questions containing pictures
5. **Images With Text**: Of those, keep only the ones whose pictures contain words (uses AI)
5. **Export**: Download as Excel + HTML, or as a standalone HTML page

### Only Images

The **Only Images** button is an action on the data, not an export. It scans
every question in the open file, removes the ones with no picture anywhere, and
writes the result back to `data/files/` as JSON. The app then switches to it.

An image counts whether it sits in the question, in the answer variants, or in
both — the confirmation dialog shows the split before anything is written.

**Your original file is never modified.** The result is saved beside it as
`<fileId>_images` and appears in the file manager as its own entry, so the full
set is always one click away.

No AI is involved — images are already detected when a file is uploaded, so this
is a deterministic filter.

The button shows how many image questions the open file has, and disables itself
when there is nothing to remove.

### Images With Text

The **Images With Text** button is step 2. It sends each image to a vision model
and keeps only the questions whose pictures contain *words* — the ones that
could be translated later.

| Kind | Meaning | Kept? |
|---|---|---|
| words | at least one real word, any language or script | yes |
| numeric | only digits, formulas, units or single-letter labels | no |
| none | no readable text at all | no |

It also reports **which language** those words are in, and the dialog's
**"Keep text in"** picker can require a specific one — Russian by default. Text
in a language you are not translating into is treated like no text at all, so
those questions are removed too. Choose *Any language* to skip the check.

So a diagram labelled `1 2 3 4`, or an axis marked `V_a`, is dropped even though
it is an image; one labelled `Растения / Корень / Стебель / Лист` is kept.

This is the only feature that calls a model. It uses whichever model is selected
in the **AI Model** panel, through OpenRouter, one request per distinct image.

**Each image is paid for once, ever.** Verdicts are cached in
`data/image-text-cache.json`, keyed by the image bytes plus the model name, so
re-running is free and the same picture in another file is free too. Changing
model re-analyses rather than trusting the old verdict.

Both filter actions run in an in-app dialog: it shows the plan first, then live
progress (*"Reading image 74 of 128 — 57%"*), then the result. The dialog will
not close while a job is running.

`IMAGE_ANALYSIS_CONCURRENCY` (default 4) controls how many images are in flight.
`IMAGE_TEXT_CACHE_PATH` moves the verdict cache elsewhere, which is useful when
testing so a run cannot discard results you have already paid for.
As with step 1, the original file is untouched and the result is saved beside it.

### Translate Images

Step 3 sends each picture to an image-generation model and gets it back redrawn
with its words in the target language. Numbers, formulas and single-letter
labels are left alone.

**This one costs real money.** Measured, per image:

| Model | Per image | 67 images |
|---|---|---|
| `google/gemini-3-pro-image` | $0.139 | ~$9.32 |
| `openai/gpt-5.4-image-2` | ~$0.05 | ~$3.35 |
| `google/gemini-2.5-flash-image` | $0.039 | ~$2.60 |

So the dialog shows an estimate before anything runs, the running total while it
does, and **"How many" defaults to the first 3 images** — judge the quality for
about 40 cents before committing to a whole file. Images are processed one at a
time, deliberately: parallelism would only multiply the cost of a wrong setting.

Each image is redrawn **once, ever** — results are cached by image + language +
model in `data/image-translate-cache.json`, written after every image so a stop
never discards paid work.

**What it does not do:** patch pixels. Editing models regenerate the whole
picture, so the diagram is reproduced faithfully rather than preserved exactly.
Check the first few before a full run. The model also picks its own canvas size,
so the result is pinned to the original display size with `width`/`height` —
layouts never move, and the stored pixels end up sharper than the original. Your
untouched original stays in the cell, and the source file is never modified.

### Reading the toolbar

The table toolbar is split so it is obvious which buttons change your file and
which only save a copy:

| Group | Buttons | Effect |
|---|---|---|
| **Filter file** | Only Images, Images With Text, Translate Images | Writes a new JSON in `data/files/` and switches to it |
| **Download** | Excel + HTML, Export to HTML | Downloads a copy; changes nothing |

Underneath, a summary line reports what the open file holds: questions, columns,
cells, how many questions carry images, and how many images there are in total.

### Keyboard shortcuts

| Key | Where | Action |
|---|---|---|
| `Esc` | any panel | Close the panel |
| `Enter` | editing a cell | Save the edit |
| `Esc` | editing a cell | Cancel the edit |

### Table pagination

The table shows one page at a time, which keeps the number of cells in the
browser constant no matter how large the file is. This is what makes the first
paint and scrolling fast on files with thousands of rows.

- **Rows per page**: 50, 100 (default), 250, 500, or All. The choice is
  remembered in your browser.
- Row numbers are always the real row numbers in the file, so row 201 is row 201
  whichever page it lands on.
- **Exports are never affected by the current page** — "Excel + HTML" and
  "Export to HTML" always contain the whole file.
- Picking **All** on a very large file still works: it paints a screenful first
  and fills in the rest in the background, showing *"Loading rows…"* while it does.

## ⚙️ Configuration

### Environment Variables

```env
# Required - the only credential the app uses.
# One key serves every model in the picker. https://openrouter.ai/keys
OPENROUTER_API_KEY=your_openrouter_api_key_here

# Optional - attribution shown on your OpenRouter dashboard
OPENROUTER_SITE_URL=http://localhost:3010
OPENROUTER_APP_NAME=Excel Content Processor

# Optional - pin a specific OpenRouter model id (JSON, app id -> OpenRouter id)
OPENROUTER_MODEL_MAP={"gpt-4o":"openai/gpt-4o-2024-11-20"}

# Optional - point at an OpenAI-compatible gateway or proxy instead
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1

# Optional
NEXT_PUBLIC_APP_NAME=Excel Content Processor
NEXT_PUBLIC_APP_VERSION=3.0.0

# Optional - parallel translation batches (default: 4 Gemini, max 16).
# Lower it if you hit rate limits, raise it if your plan allows.
TRANSLATION_CONCURRENCY=4
```

### Configuring the models

Every model the app offers is defined in `.env` — nothing is hardcoded. Change a
line and restart; no code edit, no rebuild.

```env
# Text translation models shown in the AI Model panel
TRANSLATION_MODELS=openai/gpt-4o-mini|GPT-4o Mini,google/gemini-2.5-pro|Gemini 2.5 Pro
TRANSLATION_MODEL_DEFAULT=openai/gpt-4o-mini

# Model that reads text inside images (must accept image input)
IMAGE_TEXT_MODEL=openai/gpt-4o-mini

# Image-generation models for Translate Images — id|Label|costPerImage
IMAGE_TRANSLATE_MODELS=google/gemini-3-pro-image|Gemini 3 Pro Image|0.139
IMAGE_TRANSLATE_MODEL_DEFAULT=google/gemini-3-pro-image
```

The `|Label` is optional — without it the name is derived from the id. The
provider shown in the picker comes from the id's owner prefix. A default that
is not in its own list falls back to the first entry.

### AI provider

Every model in the picker is served by **OpenRouter** — there are no direct
OpenAI or Google AI Studio paths. The model names in the UI stay the same; the
app maps them to OpenRouter ids internally:

| Model in the app | Sent to OpenRouter as |
|---|---|
| Gemini 3 Flash | `google/gemini-3-flash-preview` |
| Gemini 2.5 Flash | `google/gemini-2.5-flash` |
| Gemini 2.5 Pro | `google/gemini-2.5-pro` |

The **AI Model** panel shows which provider is live, and warns in red when no
key is configured.

### What is configurable

Everything that affects behaviour lives in `.env`, except the translation model,
which is chosen in the **AI Model** panel and remembered per browser.

A "Settings" panel used to offer batch size, caching, retries and export options.
None of those values were read by any code, so the panel was removed in 3.0
rather than left implying it did something. Use `TRANSLATION_CONCURRENCY` for
real throughput control.

## 🛠️ Development

### Available Scripts

```bash
npm run dev          # Start development server
npm run build        # Build for production
npm run start        # Start production server
npm run lint         # Run ESLint
npm run type-check   # Run TypeScript checks
```

### Adding New Features

1. **New API endpoints**: Add to `src/app/api/`
2. **New components**: Add to `src/components/`
3. **New services**: Add to `src/lib/`
4. **New types**: Add to `src/types/`

## 📦 Dependencies

### Core
- **Next.js 14**: React framework with App Router
- **TypeScript**: Type safety
- **TailwindCSS**: Styling
- **Zustand**: State management

### Processing
- **ExcelJS**: Excel file processing
- **OpenRouter**: single gateway for every translation model
- **Cheerio**: HTML parsing

### UI Components
- **Shadcn/ui**: Modern UI components
- **Lucide React**: Icons
- **React Dropzone**: File uploads

## 🔒 Security

- File size limits (50MB max)
- File type validation
- Input sanitization
- Error handling and logging

## 🚀 Deployment

### Vercel (Recommended)
1. Connect your GitHub repository
2. Set environment variables
3. Deploy automatically

### Other Platforms
1. Build the project: `npm run build`
2. Start the server: `npm run start`
3. Set environment variables

## 📝 License

MIT License - see LICENSE file for details

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## 📞 Support

For issues and questions:
- Check the GitHub issues
- Create a new issue
- Contact the development team

---

**Excel Content Processor v3.4.3** - Making data processing simple, powerful and fast! 🚀
