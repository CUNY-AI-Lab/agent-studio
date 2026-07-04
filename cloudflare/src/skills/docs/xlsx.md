# XLSX spreadsheets

## Overview
Read and write Excel workbooks as durable workspace files. Both operations run
host-side inside the Worker (SheetJS) and are exposed to codemode as
`codemode.read_xlsx` and `codemode.write_xlsx`. No external service, no Python.

## Reading a workbook
`codemode.read_xlsx` loads one sheet into JSON rows.

```js
async () => {
  const res = await codemode.read_xlsx({ filePath: "data.xlsx" });
  // res: { ok, filePath, sheetNames, sheet, rows, totalRows, truncated }
  return { sheets: res.sheetNames, rows: res.rows.length, truncated: res.truncated };
}
```

- Rows come back as an array of arrays by default (first row is usually the
  header). Pass `asObjects: true` to get header-keyed objects instead.
- Target a specific sheet with `sheet: "Sheet2"`; omit it for the first sheet.
- Reads are capped at 5,000 rows per call — check `truncated` and `totalRows`,
  and pass `maxRows` to control the slice.

## Writing a workbook
`codemode.write_xlsx` builds an `.xlsx` from sheets of array-rows and writes it
as a durable file.

```js
async () => {
  const res = await codemode.write_xlsx({
    filePath: "summary.xlsx",
    sheets: [
      { name: "Totals", rows: [["Region", "Count"], ["North", 12], ["South", 9]] },
      { name: "Notes", rows: [["Source", "Census ACS 2022"]] },
    ],
  });
  return res; // { ok, filePath, bytes, sheets }
}
```

Sheet names are truncated to Excel's 31-character limit and de-duplicated
automatically. After writing, surface the file with `ui_show_file`, or read it
back with `codemode.read_xlsx` to confirm the values landed.

## Surfacing data
- Show extracted rows on the canvas with `ui_table`, keeping source columns
  intact rather than paraphrasing them away.
- Chart aggregates with `ui_chart` when a trend matters, but keep the underlying
  workbook in the workspace so the numbers stay inspectable.

## What this can't do
- **No formulas.** Cells are written as literal values, not Excel formulas. If a
  spreadsheet needs live recalculation, say so — this pass writes static values.
- **No formatting** (fonts, colors, number formats, conditional formatting) or
  charts inside the workbook. Presentation belongs on the canvas via `ui_*`.
- **No in-place editing** that preserves an existing template's formulas or
  styling. `write_xlsx` produces a fresh workbook.

## Source-forward practice
When a spreadsheet encodes data pulled from a source, keep a provenance column or
a `Notes`/`Source` sheet naming where each figure came from (dataset, date,
identifier). A reader should be able to open the workbook and trace any number
back to its origin without asking you.
