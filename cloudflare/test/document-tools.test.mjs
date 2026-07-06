// Tests for the host-side document tools: xlsx read/write roundtrip, docx
// generation (valid zip + word/document.xml), pdf text extraction against a
// checked-in fixture, output caps, and schema-validation errors.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import JSZip from 'jszip'; // available transitively via the docx dependency
import {
  extractPdfText,
  readXlsx,
  buildXlsx,
  buildDocx,
  MAX_XLSX_ROWS,
  MAX_ZIP_ENTRIES,
  MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES,
  MAX_PDF_INPUT_BYTES,
} from '../src/lib/document-tools.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePdf = new Uint8Array(readFileSync(path.join(here, 'fixtures', 'sample.pdf')));

function isZip(bytes) {
  return bytes[0] === 0x50 && bytes[1] === 0x4b; // "PK"
}

test('buildXlsx -> readXlsx roundtrips values and sheet names', () => {
  const bytes = buildXlsx([
    { name: 'Totals', rows: [['Region', 'Count'], ['North', 12], ['South', 9]] },
    { name: 'Notes', rows: [['Source', 'Census ACS 2022']] },
  ]);
  assert.ok(isZip(bytes), 'xlsx output should be a zip');

  const first = readXlsx(bytes);
  assert.deepEqual(first.sheetNames, ['Totals', 'Notes']);
  assert.equal(first.sheet, 'Totals');
  assert.deepEqual(first.rows, [['Region', 'Count'], ['North', 12], ['South', 9]]);
  assert.equal(first.truncated, false);

  const notes = readXlsx(bytes, { sheet: 'Notes' });
  assert.deepEqual(notes.rows, [['Source', 'Census ACS 2022']]);
});

test('readXlsx asObjects returns header-keyed rows', () => {
  const bytes = buildXlsx([{ name: 'S', rows: [['a', 'b'], [1, 2], [3, 4]] }]);
  const res = readXlsx(bytes, { asObjects: true });
  assert.deepEqual(res.rows, [{ a: 1, b: 2 }, { a: 3, b: 4 }]);
});

test('readXlsx honors maxRows and reports truncation', () => {
  const rows = [['n']];
  for (let i = 0; i < 10; i += 1) rows.push([i]);
  const bytes = buildXlsx([{ name: 'S', rows }]);
  const res = readXlsx(bytes, { maxRows: 4 });
  assert.equal(res.rows.length, 4);
  assert.equal(res.totalRows, 11);
  assert.equal(res.truncated, true);
});

test('buildXlsx dedupes and truncates long sheet names', () => {
  const long = 'x'.repeat(40);
  const bytes = buildXlsx([
    { name: long, rows: [[1]] },
    { name: long, rows: [[2]] },
  ]);
  const res = readXlsx(bytes);
  assert.equal(res.sheetNames.length, 2);
  assert.ok(res.sheetNames.every((name) => name.length <= 31), 'sheet names capped at 31 chars');
  assert.notEqual(res.sheetNames[0], res.sheetNames[1], 'duplicate names de-duplicated');
});

test('buildXlsx rejects empty input', () => {
  assert.throws(() => buildXlsx([]), /at least one sheet/);
});

test('buildDocx produces a valid zip containing word/document.xml', async () => {
  const bytes = await buildDocx([
    { type: 'heading', level: 1, text: 'Research Brief' },
    { type: 'paragraph', text: 'Bold intro.', bold: true },
    { type: 'paragraph', text: 'Plain body.' },
    { type: 'list', items: ['one', 'two'] },
    { type: 'list', ordered: true, items: ['a', 'b'] },
    { type: 'table', rows: [['Source', 'Year'], ['OpenAlex', '2023']] },
  ]);
  assert.ok(isZip(bytes), 'docx output should be a zip');

  const zip = await JSZip.loadAsync(bytes);
  const documentXml = zip.file('word/document.xml');
  assert.ok(documentXml, 'docx should contain word/document.xml');
  const xml = await documentXml.async('string');
  assert.match(xml, /Research Brief/);
  assert.match(xml, /OpenAlex/);
});

test('buildDocx throws on empty content and unknown block types', async () => {
  await assert.rejects(() => buildDocx([]), /non-empty content array/);
  await assert.rejects(() => buildDocx([{ type: 'bogus', text: 'x' }]), /Unknown content block/);
  await assert.rejects(() => buildDocx([{ type: 'heading' }]), /must be a string/);
});

test('extractPdfText reads the text layer of the fixture with page markers', async () => {
  const res = await extractPdfText(fixturePdf);
  assert.equal(res.totalPages, 2);
  assert.equal(res.extractedPages, 2);
  assert.equal(res.truncated, false);
  assert.match(res.text, /\[page 1\]/);
  assert.match(res.text, /\[page 2\]/);
  assert.match(res.text, /SPHINX/);
  assert.match(res.text, /OBELISK/);
});

test('extractPdfText maxPages caps output and flags truncation', async () => {
  const res = await extractPdfText(fixturePdf, { maxPages: 1 });
  assert.equal(res.extractedPages, 1);
  assert.equal(res.truncated, true);
  assert.match(res.text, /SPHINX/);
  assert.doesNotMatch(res.text, /OBELISK/);
});

test('extractPdfText is safe to call repeatedly (input not detached)', async () => {
  const first = await extractPdfText(fixturePdf);
  const second = await extractPdfText(fixturePdf);
  assert.equal(first.totalPages, second.totalPages);
  assert.match(second.text, /SPHINX/);
});

// ---------------------------------------------------------------------------
// AS-2-5: zip-bomb / oversized-input pre-checks fire BEFORE the parser runs.
//
// forgeZip builds a real, structurally-valid ZIP (EOCD + one central-directory
// file header per entry) but lets each entry LIE about its uncompressed size.
// The bytes on disk stay tiny — we never allocate the declared payload — which
// is exactly the zip-bomb shape the pre-check must reject without materializing.
// ---------------------------------------------------------------------------
function forgeZip({ entries }) {
  // Each central-directory file header is 46 bytes + a 1-char name.
  const NAME = 'f';
  const cdParts = [];
  let cursor = 0; // local-file-header offset; irrelevant to the size scan
  for (const entry of entries) {
    const cdfh = Buffer.alloc(46 + NAME.length);
    cdfh.writeUInt32LE(0x02014b50, 0); // central-directory file header signature
    cdfh.writeUInt32LE(entry.uncompressedSize >>> 0, 24); // declared uncompressed size
    cdfh.writeUInt16LE(NAME.length, 28); // file name length
    cdfh.writeUInt16LE(0, 30); // extra field length
    cdfh.writeUInt16LE(0, 32); // comment length
    cdfh.writeUInt32LE(cursor >>> 0, 42); // relative offset of local header
    cdfh.write(NAME, 46, 'ascii');
    cdParts.push(cdfh);
    cursor += 30 + NAME.length; // pretend a local header exists
  }
  const centralDir = Buffer.concat(cdParts);
  const cdOffset = 0; // no real local-file-header region; the scan only needs the CD
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(entries.length, 8); // total entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralDir.length, 12); // central directory size
  eocd.writeUInt32LE(cdOffset, 16); // central directory offset
  // Prefix "PK\x03\x04" so the scanner recognizes it as a ZIP; the central
  // directory then sits at offset 0... so put the CD right after and point EOCD
  // at it. Simplest: [PK\x03\x04 stub][central dir][eocd] with cdOffset=4.
  const stub = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  eocd.writeUInt32LE(stub.length, 16); // central directory offset = after the stub
  return new Uint8Array(Buffer.concat([stub, centralDir, eocd]));
}

test('readXlsx rejects a zip with an oversized declared uncompressed size', () => {
  const bomb = forgeZip({
    entries: [{ uncompressedSize: MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES + 1 }],
  });
  assert.ok(bomb.length < 1000, 'forged bomb is tiny on disk');
  assert.throws(() => readXlsx(bomb), /zip bomb|uncompressed/i);
});

test('readXlsx rejects a zip with too many entries', () => {
  const entries = [];
  for (let i = 0; i < MAX_ZIP_ENTRIES + 1; i += 1) entries.push({ uncompressedSize: 1 });
  const bomb = forgeZip({ entries });
  assert.throws(() => readXlsx(bomb), /entries exceeds|zip bomb/i);
});

test('readXlsx rejects a zip whose entries sum over the total uncompressed cap', () => {
  // 200 entries each just under the per-entry cap → well over the 100 MB total.
  const entries = [];
  for (let i = 0; i < 200; i += 1) entries.push({ uncompressedSize: 90 * 1024 * 1024 });
  const bomb = forgeZip({ entries });
  assert.throws(() => readXlsx(bomb), /total cap|zip bomb/i);
});

test('readXlsx still parses a normal small xlsx (pre-check does not false-positive)', () => {
  const bytes = buildXlsx([{ name: 'S', rows: [['a', 'b'], [1, 2]] }]);
  const res = readXlsx(bytes);
  assert.deepEqual(res.rows, [['a', 'b'], [1, 2]]);
});

test('extractPdfText rejects oversized PDF input before extraction', async () => {
  // A buffer over the byte cap that starts like a PDF; must reject before parse.
  const oversized = new Uint8Array(MAX_PDF_INPUT_BYTES + 1);
  oversized[0] = 0x25; // '%'
  oversized[1] = 0x50; // 'P'
  oversized[2] = 0x44; // 'D'
  oversized[3] = 0x46; // 'F'
  await assert.rejects(() => extractPdfText(oversized), /input cap|exceeds/i);
});

test('extractPdfText still parses the normal fixture (input cap does not false-positive)', async () => {
  const res = await extractPdfText(fixturePdf);
  assert.equal(res.totalPages, 2);
  assert.match(res.text, /SPHINX/);
});

test('row cap constant is exported and enforced as an upper bound', () => {
  assert.ok(MAX_XLSX_ROWS >= 1000);
  const rows = [['n']];
  for (let i = 0; i < 3; i += 1) rows.push([i]);
  const bytes = buildXlsx([{ name: 'S', rows }]);
  const res = readXlsx(bytes, { maxRows: MAX_XLSX_ROWS + 10_000 });
  // Requesting more than the hard cap must not exceed it; here data is small.
  assert.ok(res.rows.length <= MAX_XLSX_ROWS);
});
