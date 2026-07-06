# PDF text extraction

## Overview
Pull the text layer out of a PDF workspace file so you can quote, summarize, or
tabulate its contents. Extraction runs host-side inside the Worker and is
exposed to codemode as `codemode.parse_pdf`. There is no external service and no
Python — everything happens in the Worker.

## Workflow
Call `codemode.parse_pdf` from inside codemode, keep the source PDF in the
workspace, and surface what you extract as a durable artifact or a tile.

```js
async () => {
  const res = await codemode.parse_pdf({ filePath: "report.pdf" });
  // res: { ok, filePath, text, totalPages, extractedPages, truncated }
  await state.writeFile("/report.txt", res.text);
  return { totalPages: res.totalPages, truncated: res.truncated };
}
```

The returned `text` is one block per page, each prefixed with a `[page N]`
marker so you can cite exact pages. Read a large PDF page-by-page when you only
need part of it:

```js
async () => {
  const first = await codemode.parse_pdf({ filePath: "thesis.pdf", maxPages: 10 });
  return { pages: first.extractedPages, more: first.truncated };
}
```

## Surfacing results
- Write the extracted text to a `.txt`/`.md` file with `state.writeFile`, then
  show it with `ui_show_file` so the reader can inspect it alongside the PDF.
- Pull structured content (dates, figures, references) into an `ui_table` and
  keep the page number as a column so every row stays traceable to the source.
- Keep the original `.pdf` in the workspace — extractions are derived views, not
  replacements.

## Output caps
`parse_pdf` caps output defensively: ~{{MAX_PDF_TEXT_CHARS}} characters and {{MAX_PDF_PAGES}} pages per call.
When `truncated` is true, either narrow with `maxPages` or process the document
in slices. Never assume you received the whole document without checking
`truncated` and `extractedPages`.

## What this can't do
- **No OCR.** This reads the embedded text layer only. Scanned or image-only
  PDFs return little or no text. If a page comes back empty, say so plainly
  rather than inventing content.
- **No layout reconstruction.** Multi-column layouts and tables come out as a
  linear stream of text; verify any table you rebuild against the source.
- **No PDF generation or editing** (merge/split/rotate/forms) in this pass — this
  is extraction only. Note the limit honestly if asked to produce a PDF.
- For live web PDFs, fetch the bytes with `codemode.web_fetch` first, write them
  to a workspace file, then `parse_pdf` that file.

## Source-forward practice
Cite page numbers for every claim you draw from a PDF — the `[page N]` markers
exist for exactly this. Keep the source PDF in the workspace next to any
extraction so a reader can open the original and check your reading. When
extraction is empty or partial, report that limit instead of paraphrasing around
it.
