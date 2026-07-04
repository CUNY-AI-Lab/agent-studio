# DOCX Word documents

## Overview
Generate a Word `.docx` from a simple declarative schema and write it as a
durable workspace file. Generation runs host-side inside the Worker (the `docx`
library) and is exposed to codemode as `codemode.write_docx`. No external
service, no Python. You describe the document with content blocks and never
touch the docx library directly.

## Content schema
`content` is an array of blocks. Supported types:

| Block | Shape | Renders as |
| --- | --- | --- |
| heading | `{ type: "heading", level: 1-6, text }` | A styled heading |
| paragraph | `{ type: "paragraph", text, bold?, italic? }` | A body paragraph |
| list | `{ type: "list", ordered?, items: [...] }` | Bulleted or numbered list |
| table | `{ type: "table", rows: [[...], ...] }` | A table (first row = header) |

## Writing a document
```js
async () => {
  const res = await codemode.write_docx({
    filePath: "brief.docx",
    content: [
      { type: "heading", level: 1, text: "Research Brief" },
      { type: "paragraph", text: "Summary of findings.", bold: true },
      { type: "paragraph", text: "Details follow below." },
      { type: "list", ordered: true, items: ["First point", "Second point"] },
      { type: "table", rows: [["Source", "Year"], ["OpenAlex", "2023"]] },
    ],
  });
  return res; // { ok, filePath, bytes, blocks }
}
```

After writing, surface the document with `ui_show_file` so the user gets a
downloadable artifact rather than pasted prose. For a long document, assemble the
`content` array in codemode (looping over your data) instead of hand-writing
every block.

## What this can't do
- **Generation only** in this pass — no reading, editing, tracked changes, or
  comments on an existing `.docx`. If asked to redline someone else's document,
  say that isn't available yet.
- **No images, headers/footers, page numbers, or custom fonts/themes.** The
  schema covers headings, paragraphs (bold/italic), lists, and tables. If a
  request needs more, note the limit rather than faking it.
- **No PPTX.** Slide decks are not carried over on this platform.

## Source-forward practice
When a document reports findings from a search or dataset, embed the identifiers
a reader needs to verify them — DOIs, URLs, catalog permalinks — directly in the
paragraphs or in a `Sources` table at the end. Keep any source files you drew
from in the workspace alongside the generated document so the evidence trail
stays intact.
