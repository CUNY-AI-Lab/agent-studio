// Tests for the upload type allowlist (ported from the legacy app).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isAllowedUpload } from '../src/lib/upload-validation.ts';

test('allowed research file types pass', () => {
  for (const file of [
    { name: 'paper.pdf', type: 'application/pdf' },
    { name: 'data.csv', type: 'text/csv' },
    { name: 'notes.md', type: '' },
    { name: 'records.json', type: 'application/json' },
    { name: 'sheet.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    { name: 'figure.png', type: 'image/png' },
    { name: 'UPPER.PDF', type: 'application/pdf' },
    { name: 'export.xml', type: 'application/octet-stream' }, // generic MIME, valid extension
  ]) {
    assert.deepEqual(isAllowedUpload(file), { allowed: true }, file.name);
  }
});

test('executable, script, and unknown types are rejected', () => {
  for (const file of [
    { name: 'run.exe', type: 'application/octet-stream' },
    { name: 'script.sh', type: 'text/x-sh' },
    { name: 'page.html', type: 'text/html' },
    { name: 'archive.zip', type: 'application/zip' },
    { name: 'noextension', type: 'text/plain' },
    { name: 'evil.pdf.js', type: 'text/javascript' },
  ]) {
    assert.equal(isAllowedUpload(file).allowed, false, file.name);
  }
});

test('valid extension with a lying disallowed MIME type is rejected', () => {
  assert.equal(isAllowedUpload({ name: 'fake.pdf', type: 'text/html' }).allowed, false);
});
