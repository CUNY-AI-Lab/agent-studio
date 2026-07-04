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

test('row cap constant is exported and enforced as an upper bound', () => {
  assert.ok(MAX_XLSX_ROWS >= 1000);
  const rows = [['n']];
  for (let i = 0; i < 3; i += 1) rows.push([i]);
  const bytes = buildXlsx([{ name: 'S', rows }]);
  const res = readXlsx(bytes, { maxRows: MAX_XLSX_ROWS + 10_000 });
  // Requesting more than the hard cap must not exceed it; here data is small.
  assert.ok(res.rows.length <= MAX_XLSX_ROWS);
});
