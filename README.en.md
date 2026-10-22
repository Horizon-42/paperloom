# Paperloom

[中文](README.md)

**Weave every paper you read into your own web of knowledge.**

A local-first paper reader that runs in your browser. Read PDFs, highlight and annotate, and build your own glossary: **write a note for a term or acronym once, and every occurrence in every paper gets underlined — click it to see your note.**

Your papers and notes stay on your own computer. Nothing is uploaded to any server.

> The interface is currently Chinese only.

<!-- Online version: add the link and a demo GIF here after deploying -->

## Features

- **Word-precise highlights**: positions come from the PDF's glyph geometry, so highlights hug each word instead of drifting by half a word. Notes are Markdown (with math) and sit in the margin, aligned with the text.
- **Personal glossary**: each term can have aliases (acronym, full form, plurals). Every match across all papers is underlined automatically. Terms can be scoped to specific fields, so the same acronym can mean different things in different areas.
- **Library**: nested fields (a paper can belong to several), tags, search and filters.
- **Side by side**: tabs and a split view for comparing two papers.
- **Note canvas**: arrange highlights, terms and papers on a canvas and link them.
- **Projects**: each project is a fully separate set of papers and notes; open different projects in different browser tabs.
- **Import / export**: full JSON backups; terms and highlights export to Markdown for Obsidian.

## Two ways to use it

### Online version

Data is stored in your browser (IndexedDB). Clearing site data, switching browsers or computers will lose it, so export a backup regularly from "数据与备份" (Data & backup) at the bottom left.

### Run locally (recommended for long-term use)

Requires [Node.js](https://nodejs.org/) 20.19 or newer.

```bash
git clone <repository-url> paperlens
cd paperlens
npm install
npm run dev
```

Then open <http://localhost:5173>. When running locally, everything is mirrored automatically to the `data/` folder in the repository (PDFs, `library.json`, Markdown notes), so you can recover even if the browser's data is lost. Use `PAPERLENS_DATA_DIR=<dir> npm run dev` to keep the data elsewhere (for example a synced folder).

The local service only accepts requests from the same machine.

## Deploy your own online version

```bash
npm run build:web   # outputs dist/ with relative paths; works under any sub-path
```

Upload `dist/` to any static host. A GitHub Pages workflow is included (`.github/workflows/pages.yml`): set Settings → Pages → Source to GitHub Actions, and every push to `main` deploys.

## Development

```bash
npm run typecheck
npm test            # unit tests (Vitest)
npm run e2e         # end-to-end tests (Playwright)
npx playwright test -c tests/e2e/static.config.ts   # smoke test for the static build
```

Design notes (in Chinese) are in `Paperloom 论文阅读器开发文档.md` and `docs/decisions.md`.

Built with React, TypeScript, Vite, pdf.js, Dexie (IndexedDB), Zustand, Tailwind CSS, Radix UI, CodeMirror and React Flow.

## Known limitations

- Scanned PDFs need an embedded (OCR) text layer for selecting text and matching terms.
- No multi-device sync or collaboration.

## License

[MIT](LICENSE)
