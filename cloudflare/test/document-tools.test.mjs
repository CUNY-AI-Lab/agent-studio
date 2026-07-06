// Tests for the host-side document tools: xlsx read/write roundtrip, docx
// generation (valid zip + word/document.xml), pdf text extraction against a
// checked-in fixture, output caps, and schema-validation errors.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { deflateRawSync } from 'node:zlib';
import JSZip from 'jszip'; // available transitively via the docx dependency
import {
  extractPdfText,
  readXlsx,
  buildXlsx,
  buildDocx,
  MAX_XLSX_ROWS,
  MAX_ZIP_ENTRIES,
  MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES,
  MAX_PDF_INPUT_BYTES,
} from '../src/lib/document-tools.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePdf = new Uint8Array(readFileSync(path.join(here, 'fixtures', 'sample.pdf')));

function isZip(bytes) {
  return bytes[0] === 0x50 && bytes[1] === 0x4b; // "PK"
}

test('buildXlsx -> readXlsx roundtrips values and sheet names', async () => {
  const bytes = buildXlsx([
    { name: 'Totals', rows: [['Region', 'Count'], ['North', 12], ['South', 9]] },
    { name: 'Notes', rows: [['Source', 'Census ACS 2022']] },
  ]);
  assert.ok(isZip(bytes), 'xlsx output should be a zip');

  const first = await readXlsx(bytes);
  assert.deepEqual(first.sheetNames, ['Totals', 'Notes']);
  assert.equal(first.sheet, 'Totals');
  assert.deepEqual(first.rows, [['Region', 'Count'], ['North', 12], ['South', 9]]);
  assert.equal(first.truncated, false);

  const notes = await readXlsx(bytes, { sheet: 'Notes' });
  assert.deepEqual(notes.rows, [['Source', 'Census ACS 2022']]);
});

test('readXlsx asObjects returns header-keyed rows', async () => {
  const bytes = buildXlsx([{ name: 'S', rows: [['a', 'b'], [1, 2], [3, 4]] }]);
  const res = await readXlsx(bytes, { asObjects: true });
  assert.deepEqual(res.rows, [{ a: 1, b: 2 }, { a: 3, b: 4 }]);
});

test('readXlsx honors maxRows and reports truncation', async () => {
  const rows = [['n']];
  for (let i = 0; i < 10; i += 1) rows.push([i]);
  const bytes = buildXlsx([{ name: 'S', rows }]);
  const res = await readXlsx(bytes, { maxRows: 4 });
  assert.equal(res.rows.length, 4);
  assert.equal(res.totalRows, 11);
  assert.equal(res.truncated, true);
});

test('buildXlsx dedupes and truncates long sheet names', async () => {
  const long = 'x'.repeat(40);
  const bytes = buildXlsx([
    { name: long, rows: [[1]] },
    { name: long, rows: [[2]] },
  ]);
  const res = await readXlsx(bytes);
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
// AS-2-5: bounded ZIP pre-inflation is the REAL memory ceiling. It runs BEFORE
// XLSX.read and counts ACTUAL inflated bytes, so it catches the dangerous
// zip-bomb shape: an entry that LIES SMALL in its declared uncompressed-size
// field but whose deflate stream inflates to gigabytes. (SheetJS ignores the
// declared field and inflates the real stream, so the old declared-size scan
// was theater against this shape.)
//
// buildRealZip assembles a structurally valid single-entry ZIP (local header +
// deflate stream + central directory + EOCD) from a chosen compressed payload,
// with the declared uncompressed size set to whatever `declaredUncompressed`
// says — letting us forge a stream that inflates far past what it declares.
// ---------------------------------------------------------------------------
function buildRealZip({ method, compressed, declaredUncompressed, name = 'f' }) {
  const nameBuf = Buffer.from(name, 'ascii');
  const crc = 0; // parsers we bound never validate CRC in the pre-inflation pass

  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0); // local file header signature
  lfh.writeUInt16LE(20, 4); // version needed
  lfh.writeUInt16LE(0, 6); // flags
  lfh.writeUInt16LE(method, 8); // compression method
  lfh.writeUInt16LE(0, 10); // mod time
  lfh.writeUInt16LE(0, 12); // mod date
  lfh.writeUInt32LE(crc >>> 0, 14); // crc-32
  lfh.writeUInt32LE(compressed.length >>> 0, 18); // compressed size
  lfh.writeUInt32LE(declaredUncompressed >>> 0, 22); // DECLARED uncompressed size (the lie)
  lfh.writeUInt16LE(nameBuf.length, 26); // name length
  lfh.writeUInt16LE(0, 28); // extra length

  const localPart = Buffer.concat([lfh, nameBuf, compressed]);
  const cdOffset = localPart.length;

  const cdfh = Buffer.alloc(46);
  cdfh.writeUInt32LE(0x02014b50, 0); // central-directory file header signature
  cdfh.writeUInt16LE(20, 4); // version made by
  cdfh.writeUInt16LE(20, 6); // version needed
  cdfh.writeUInt16LE(0, 8); // flags
  cdfh.writeUInt16LE(method, 10); // compression method
  cdfh.writeUInt32LE(crc >>> 0, 16); // crc-32
  cdfh.writeUInt32LE(compressed.length >>> 0, 20); // compressed size
  cdfh.writeUInt32LE(declaredUncompressed >>> 0, 24); // DECLARED uncompressed size (the lie)
  cdfh.writeUInt16LE(nameBuf.length, 28); // name length
  cdfh.writeUInt16LE(0, 30); // extra length
  cdfh.writeUInt16LE(0, 32); // comment length
  cdfh.writeUInt32LE(0, 42); // local header offset
  const centralDir = Buffer.concat([cdfh, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(1, 8); // entries on this disk
  eocd.writeUInt16LE(1, 10); // total entries
  eocd.writeUInt32LE(centralDir.length, 12); // central directory size
  eocd.writeUInt32LE(cdOffset, 16); // central directory offset

  return new Uint8Array(Buffer.concat([localPart, centralDir, eocd]));
}

test('readXlsx STOPS a lying-small zip bomb (declares tiny, inflates over the cap)', async () => {
  // A deflate stream of >cap zeros compresses to a few hundred KB, but we
  // declare its uncompressed size as a tiny 100 bytes — the exact under-declaring
  // shape SheetJS would inflate for real. The bounded pre-inflation must abort.
  const payloadSize = MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES + 8 * 1024 * 1024; // ~108 MB of zeros
  const compressed = deflateRawSync(Buffer.alloc(payloadSize, 0));
  const bomb = buildRealZip({ method: 8, compressed, declaredUncompressed: 100 });

  // On disk the bomb is tiny and its DECLARED size is a lie (100 bytes).
  assert.ok(bomb.length < 2 * 1024 * 1024, 'bomb is small on disk (< 2 MB compressed)');

  await assert.rejects(
    () => readXlsx(bomb),
    /zip bomb|decompressed size exceeds/i,
    'bounded pre-inflation must reject the under-declaring bomb by ACTUAL inflated size',
  );
});

test('readXlsx rejects a zip with too many entries (cheap fast reject)', async () => {
  // A structurally valid multi-entry ZIP over the entry-count cap. Each entry is
  // an empty stored file, so nothing inflates — the count check fires first.
  const NAME = 'f';
  const nameBuf = Buffer.from(NAME, 'ascii');
  const n = MAX_ZIP_ENTRIES + 1;
  const localParts = [];
  const cdParts = [];
  let offset = 0;
  for (let i = 0; i < n; i += 1) {
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(0, 8); // stored
    lfh.writeUInt16LE(nameBuf.length, 26);
    const localPart = Buffer.concat([lfh, nameBuf]);
    const cdfh = Buffer.alloc(46);
    cdfh.writeUInt32LE(0x02014b50, 0);
    cdfh.writeUInt16LE(0, 10); // stored
    cdfh.writeUInt16LE(nameBuf.length, 28);
    cdfh.writeUInt32LE(offset >>> 0, 42);
    cdParts.push(Buffer.concat([cdfh, nameBuf]));
    localParts.push(localPart);
    offset += localPart.length;
  }
  const local = Buffer.concat(localParts);
  const centralDir = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(n, 8);
  eocd.writeUInt16LE(n, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  const bomb = new Uint8Array(Buffer.concat([local, centralDir, eocd]));

  await assert.rejects(() => readXlsx(bomb), /entries exceeds|zip bomb/i);
});

test('readXlsx rejects a zip using an unsupported compression method', async () => {
  // Method 12 (bzip2) is not stored/deflate; we cannot bound it, so reject.
  const bomb = buildRealZip({ method: 12, compressed: Buffer.alloc(10), declaredUncompressed: 100 });
  await assert.rejects(() => readXlsx(bomb), /unsupported compression method/i);
});

test('readXlsx still parses a normal small xlsx (pre-inflation does not false-positive)', async () => {
  const bytes = buildXlsx([{ name: 'S', rows: [['a', 'b'], [1, 2]] }]);
  const res = await readXlsx(bytes);
  assert.deepEqual(res.rows, [['a', 'b'], [1, 2]]);
});

test('readXlsx allows a large-but-legit xlsx under the total-inflation cap', async () => {
  // A workbook whose inflated content is real but well under the 100 MB cap must
  // pass — proving the ceiling is not so tight it rejects legitimate files.
  const rows = [['id', 'value']];
  for (let i = 0; i < 2000; i += 1) rows.push([i, `row-${i}`]);
  const bytes = buildXlsx([{ name: 'Big', rows }]);
  const res = await readXlsx(bytes);
  assert.equal(res.rows.length, 2001);
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

test('row cap constant is exported and enforced as an upper bound', async () => {
  assert.ok(MAX_XLSX_ROWS >= 1000);
  const rows = [['n']];
  for (let i = 0; i < 3; i += 1) rows.push([i]);
  const bytes = buildXlsx([{ name: 'S', rows }]);
  const res = await readXlsx(bytes, { maxRows: MAX_XLSX_ROWS + 10_000 });
  // Requesting more than the hard cap must not exceed it; here data is small.
  assert.ok(res.rows.length <= MAX_XLSX_ROWS);
});
