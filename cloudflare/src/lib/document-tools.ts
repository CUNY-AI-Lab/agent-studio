/**
 * Host-side document processing for the workspace agent.
 *
 * These are pure, byte-in/JSON-out functions that run inside the main Worker
 * (never in the Dynamic Worker sandbox, and never against an external service —
 * the CAIL contract requires document processing to stay inside the Worker).
 * The workspace agent exposes them to codemode as host tools (parse_pdf,
 * read_xlsx, write_xlsx, write_docx) exactly like web_fetch, so the model never
 * touches the underlying pdf.js / SheetJS / docx APIs directly.
 *
 * Libraries (all pure-JS, workerd-compatible under nodejs_compat):
 *   - unpdf  : serverless pdf.js build for text extraction
 *   - xlsx   : SheetJS CE for spreadsheet read/write
 *   - docx   : Word document generation from a declarative schema
 *
 * Outputs are capped defensively so a huge document can never flood model
 * context or the DO. Every cap that trips is reported via a `truncated` flag.
 */

import { extractText } from 'unpdf';
import * as XLSX from 'xlsx';
import {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
} from 'docx';

/** Cap on characters returned from PDF text extraction. */
export const MAX_PDF_TEXT_CHARS = 200_000;
/** Cap on pages processed for PDF text extraction. */
export const MAX_PDF_PAGES = 500;
/** Cap on rows returned from a spreadsheet read. */
export const MAX_XLSX_ROWS = 5_000;
/** Cap on sheets a single build/read touches. */
export const MAX_XLSX_SHEETS = 50;

// ---------------------------------------------------------------------------
// Input caps (zip-bomb / OOM defense — AS-2-5)
//
// The output caps above only trim what a caller *sees*; they run AFTER the
// parser has fully materialized the document in memory. A tiny xlsx/docx (both
// are ZIP containers) can declare gigabytes of uncompressed content and OOM the
// isolate before any output cap is reached. We therefore pre-screen the raw
// bytes BEFORE handing them to the parser: a compressed-size cap on the raw
// input, plus a dependency-free ZIP central-directory scan that rejects
// zip-bombs by their *declared* uncompressed size and entry count.
// ---------------------------------------------------------------------------

/** Reject xlsx/xls/csv input larger than this many compressed bytes on disk. */
export const MAX_XLSX_INPUT_BYTES = 25 * 1024 * 1024; // 25 MB
/** Reject a ZIP (xlsx) whose central directory lists more than this many entries. */
export const MAX_ZIP_ENTRIES = 512;
/** Reject a ZIP whose entries sum to more than this many declared uncompressed bytes. */
export const MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES = 100 * 1024 * 1024; // 100 MB
/** Reject a ZIP any single entry of which declares more than this many uncompressed bytes. */
export const MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES = 100 * 1024 * 1024; // 100 MB
/** Reject PDF input larger than this many bytes before extraction. */
export const MAX_PDF_INPUT_BYTES = 30 * 1024 * 1024; // 30 MB

/**
 * Dependency-free ZIP zip-bomb pre-check. Walks the End Of Central Directory
 * record and the central-directory file headers, summing each entry's DECLARED
 * uncompressed size (a 32-bit field in the CDFH — no decompression happens, so
 * this stays cheap even for a forged bomb). Throws if the entry count or the
 * declared uncompressed sizes exceed the caps above. This intentionally reads
 * only the central directory: the whole point is to reject BEFORE any parser
 * inflates the compressed data.
 *
 * Only ZIP containers are screened here; a non-ZIP input (e.g. a legacy .xls or
 * a .csv passed to readXlsx) is left to the compressed-byte cap and the parser.
 */
export function assertZipWithinCaps(bytes: Uint8Array): void {
  // "PK\x03\x04" (local file header) marks a ZIP. Anything else is not a ZIP
  // container and is not screened by this function.
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    return;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const EOCD_SIGNATURE = 0x06054b50;
  const CDFH_SIGNATURE = 0x02014b50;

  // Find the End Of Central Directory record: scan backwards from EOF. The EOCD
  // is 22 bytes plus a comment of up to 65535 bytes, so we never look further
  // back than that window.
  const minEocd = 22;
  if (bytes.length < minEocd) {
    throw new Error('Invalid ZIP: file too small to contain a central directory');
  }
  const maxComment = 0xffff;
  const scanStart = bytes.length - minEocd;
  const scanEnd = Math.max(0, bytes.length - minEocd - maxComment);
  let eocd = -1;
  for (let i = scanStart; i >= scanEnd; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('Invalid ZIP: End Of Central Directory record not found');
  }

  const entryCount = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);

  if (entryCount > MAX_ZIP_ENTRIES) {
    throw new Error(
      `ZIP rejected: ${entryCount} entries exceeds the ${MAX_ZIP_ENTRIES}-entry cap (possible zip bomb)`,
    );
  }

  // Walk the central directory. Each central-directory file header (CDFH) is
  // 46 bytes fixed plus variable name/extra/comment fields; the 32-bit
  // uncompressed size lives at offset 24 within the header.
  let cursor = cdOffset;
  let totalUncompressed = 0;
  for (let n = 0; n < entryCount; n += 1) {
    if (cursor + 46 > bytes.length) {
      throw new Error('Invalid ZIP: central directory truncated');
    }
    if (view.getUint32(cursor, true) !== CDFH_SIGNATURE) {
      throw new Error('Invalid ZIP: bad central-directory file header signature');
    }
    const uncompressedSize = view.getUint32(cursor + 24, true);
    if (uncompressedSize > MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES) {
      throw new Error(
        `ZIP rejected: an entry declares ${uncompressedSize} uncompressed bytes, ` +
          `over the ${MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES}-byte per-entry cap (possible zip bomb)`,
      );
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error(
        `ZIP rejected: declared uncompressed size exceeds the ` +
          `${MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES}-byte total cap (possible zip bomb)`,
      );
    }
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    cursor += 46 + nameLen + extraLen + commentLen;
  }
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

export interface ExtractPdfTextOptions {
  /** Only extract the first N pages (1-based count). Defaults to all pages. */
  maxPages?: number;
}

export interface ExtractPdfTextResult {
  /** Extracted text, page blocks joined by a form-feed-style separator. */
  text: string;
  /** Total pages in the document (independent of how many were extracted). */
  totalPages: number;
  /** Number of pages actually extracted into `text`. */
  extractedPages: number;
  /** True if page count or the character cap limited the output. */
  truncated: boolean;
}

/**
 * Extract plain text from a PDF. This is a text-layer extraction only: scanned
 * / image-only PDFs return little or no text (there is no OCR on the Worker).
 * Per-page text blocks are joined so callers can attribute content to a page.
 */
export async function extractPdfText(
  bytes: Uint8Array,
  options: ExtractPdfTextOptions = {},
): Promise<ExtractPdfTextResult> {
  // INPUT cap (AS-2-5): reject an oversized PDF before extractText materializes
  // it. A PDF is not a ZIP, so a cheap central-directory scan isn't available;
  // an object-count / stream-length bomb can't be pre-checked without a full
  // parse. The honest residual bound is this raw byte cap + MAX_PDF_PAGES +
  // MAX_PDF_TEXT_CHARS + pdf.js's own internal limits.
  if (bytes.length > MAX_PDF_INPUT_BYTES) {
    throw new Error(
      `PDF rejected: ${bytes.length} bytes exceeds the ${MAX_PDF_INPUT_BYTES}-byte input cap for a parse operation`,
    );
  }

  // Pass bytes directly rather than via getDocumentProxy: the proxy path spins
  // up a pdf.js worker whose structured-clone transfer fails under some Node
  // versions, and unpdf manages the document lifecycle internally either way.
  // Copy first — pdf.js transfers (and detaches) the input buffer, so passing
  // the caller's array would make it unusable and break repeat calls.
  const { totalPages, text: pages } = await extractText(bytes.slice(), { mergePages: false });

  const requestedPages = options.maxPages && options.maxPages > 0
    ? Math.min(options.maxPages, MAX_PDF_PAGES)
    : Math.min(totalPages, MAX_PDF_PAGES);

  let truncated = requestedPages < totalPages;
  const blocks: string[] = [];
  let charCount = 0;

  for (let i = 0; i < requestedPages && i < pages.length; i += 1) {
    const pageText = (pages[i] ?? '').trim();
    const block = `[page ${i + 1}]\n${pageText}`;
    if (charCount + block.length > MAX_PDF_TEXT_CHARS) {
      const remaining = MAX_PDF_TEXT_CHARS - charCount;
      if (remaining > 0) {
        blocks.push(block.slice(0, remaining));
      }
      truncated = true;
      break;
    }
    blocks.push(block);
    charCount += block.length + 2;
  }

  return {
    text: blocks.join('\n\n'),
    totalPages,
    extractedPages: blocks.length,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// XLSX (read)
// ---------------------------------------------------------------------------

export type XlsxCell = string | number | boolean | null;

export interface ReadXlsxOptions {
  /** Read a single sheet by name. Defaults to the first sheet. */
  sheet?: string;
  /** Cap the number of data rows returned. */
  maxRows?: number;
  /**
   * When true, the first row is treated as a header and each row is returned
   * as an object keyed by header. Otherwise rows are arrays-of-cells.
   */
  asObjects?: boolean;
}

export interface ReadXlsxResult {
  /** Every sheet name in the workbook. */
  sheetNames: string[];
  /** The sheet actually read. */
  sheet: string;
  /** Row data: array-of-arrays, or array-of-objects when asObjects is set. */
  rows: XlsxCell[][] | Record<string, XlsxCell>[];
  /** Total data rows available in the sheet before the maxRows cap. */
  totalRows: number;
  /** True if maxRows limited the output. */
  truncated: boolean;
}

/** Read one sheet of an xlsx/xls/csv workbook into JSON rows. */
export function readXlsx(bytes: Uint8Array, options: ReadXlsxOptions = {}): ReadXlsxResult {
  // INPUT caps (AS-2-5): screen the raw bytes BEFORE XLSX.read materializes the
  // workbook. xlsx/xlsm/docx are ZIP containers, so a small compressed file can
  // decompress to gigabytes and OOM the isolate. Cap the compressed input, then
  // reject a zip-bomb by its declared uncompressed size / entry count.
  if (bytes.length > MAX_XLSX_INPUT_BYTES) {
    throw new Error(
      `Workbook rejected: ${bytes.length} bytes exceeds the ${MAX_XLSX_INPUT_BYTES}-byte input cap for a parse operation`,
    );
  }
  assertZipWithinCaps(bytes);

  const workbook = XLSX.read(bytes, { type: 'array' });
  const sheetNames = workbook.SheetNames;
  if (sheetNames.length === 0) {
    throw new Error('Workbook contains no sheets');
  }

  const targetName = options.sheet ?? sheetNames[0];
  if (!sheetNames.includes(targetName)) {
    throw new Error(`Sheet not found: ${targetName}. Available: ${sheetNames.join(', ')}`);
  }
  const worksheet = workbook.Sheets[targetName];

  const rowLimit = options.maxRows && options.maxRows > 0
    ? Math.min(options.maxRows, MAX_XLSX_ROWS)
    : MAX_XLSX_ROWS;

  if (options.asObjects) {
    const objects = XLSX.utils.sheet_to_json<Record<string, XlsxCell>>(worksheet, {
      defval: null,
      raw: true,
    });
    const totalRows = objects.length;
    const rows = objects.slice(0, rowLimit);
    return {
      sheetNames,
      sheet: targetName,
      rows,
      totalRows,
      truncated: totalRows > rows.length,
    };
  }

  const matrix = XLSX.utils.sheet_to_json<XlsxCell[]>(worksheet, {
    header: 1,
    defval: null,
    raw: true,
    blankrows: false,
  });
  const totalRows = matrix.length;
  const rows = matrix.slice(0, rowLimit);
  return {
    sheetNames,
    sheet: targetName,
    rows,
    totalRows,
    truncated: totalRows > rows.length,
  };
}

// ---------------------------------------------------------------------------
// XLSX (write)
// ---------------------------------------------------------------------------

export interface XlsxSheetSpec {
  name: string;
  /** Array-of-arrays. The first row is typically a header. */
  rows: XlsxCell[][];
}

/** Build an xlsx workbook (bytes) from one or more sheets of array-rows. */
export function buildXlsx(sheets: XlsxSheetSpec[]): Uint8Array {
  if (!Array.isArray(sheets) || sheets.length === 0) {
    throw new Error('buildXlsx requires at least one sheet');
  }
  if (sheets.length > MAX_XLSX_SHEETS) {
    throw new Error(`Too many sheets (${sheets.length}); max ${MAX_XLSX_SHEETS}`);
  }

  const workbook = XLSX.utils.book_new();
  const usedNames = new Set<string>();

  for (const spec of sheets) {
    if (!spec || typeof spec.name !== 'string' || spec.name.length === 0) {
      throw new Error('Each sheet needs a non-empty name');
    }
    if (!Array.isArray(spec.rows)) {
      throw new Error(`Sheet "${spec.name}" rows must be an array of arrays`);
    }
    // Excel sheet names are capped at 31 chars and must be unique.
    let name = spec.name.slice(0, 31);
    let suffix = 1;
    while (usedNames.has(name)) {
      const base = spec.name.slice(0, 28);
      name = `${base}_${suffix}`;
      suffix += 1;
    }
    usedNames.add(name);

    const worksheet = XLSX.utils.aoa_to_sheet(spec.rows);
    XLSX.utils.book_append_sheet(workbook, worksheet, name);
  }

  const out = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
  return out instanceof Uint8Array ? out : new Uint8Array(out);
}

// ---------------------------------------------------------------------------
// DOCX (write)
// ---------------------------------------------------------------------------

/**
 * Declarative document schema. The model builds an array of these blocks and
 * never touches the docx library directly. Supported blocks:
 *   - heading   : { type:'heading', level:1-6, text }
 *   - paragraph : { type:'paragraph', text, bold?, italic? }
 *   - list      : { type:'list', ordered?, items: string[] }
 *   - table     : { type:'table', rows: string[][] }  (first row = header)
 */
export type DocxBlock =
  | { type: 'heading'; level?: number; text: string }
  | { type: 'paragraph'; text: string; bold?: boolean; italic?: boolean }
  | { type: 'list'; ordered?: boolean; items: string[] }
  | { type: 'table'; rows: string[][] };

const HEADING_LEVELS: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

function assertString(value: unknown, context: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${context} must be a string`);
  }
  return value;
}

/** Build a .docx (bytes) from the declarative block schema. */
export async function buildDocx(content: DocxBlock[]): Promise<Uint8Array> {
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error('buildDocx requires a non-empty content array');
  }

  const children: (Paragraph | Table)[] = [];

  content.forEach((block, index) => {
    if (!block || typeof block !== 'object' || typeof block.type !== 'string') {
      throw new Error(`Content block ${index} is missing a "type"`);
    }
    switch (block.type) {
      case 'heading': {
        const level = Number(block.level ?? 1);
        const heading = HEADING_LEVELS[level] ?? HeadingLevel.HEADING_1;
        children.push(
          new Paragraph({ text: assertString(block.text, `heading ${index}`), heading }),
        );
        break;
      }
      case 'paragraph': {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: assertString(block.text, `paragraph ${index}`),
                bold: Boolean(block.bold),
                italics: Boolean(block.italic),
              }),
            ],
          }),
        );
        break;
      }
      case 'list': {
        if (!Array.isArray(block.items)) {
          throw new Error(`list block ${index} needs an items array`);
        }
        block.items.forEach((item, itemIndex) => {
          children.push(
            new Paragraph({
              text: assertString(item, `list ${index} item ${itemIndex}`),
              bullet: block.ordered ? undefined : { level: 0 },
              numbering: block.ordered ? { reference: 'ordered-list', level: 0 } : undefined,
            }),
          );
        });
        break;
      }
      case 'table': {
        if (!Array.isArray(block.rows) || block.rows.length === 0) {
          throw new Error(`table block ${index} needs a non-empty rows array`);
        }
        const rows = block.rows.map((row, rowIndex) => {
          if (!Array.isArray(row)) {
            throw new Error(`table ${index} row ${rowIndex} must be an array`);
          }
          return new TableRow({
            children: row.map(
              (cell) =>
                new TableCell({
                  children: [new Paragraph(String(cell ?? ''))],
                }),
            ),
          });
        });
        children.push(
          new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }),
        );
        break;
      }
      default:
        throw new Error(`Unknown content block type at ${index}: ${(block as { type: string }).type}`);
    }
  });

  const doc = new Document({
    numbering: {
      config: [
        {
          reference: 'ordered-list',
          levels: [
            {
              level: 0,
              format: 'decimal',
              text: '%1.',
              alignment: 'start',
            },
          ],
        },
      ],
    },
    sections: [{ children }],
  });

  return Packer.toBuffer(doc).then((buffer) => new Uint8Array(buffer));
}
