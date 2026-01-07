import assert from 'assert';
import { describe, it } from 'node:test';
import { sanitizeFilename, isAllowedFile } from '../../src/lib/upload/validation';

describe('upload validation', () => {
  it('sanitizes filenames by replacing unsafe chars and preserving extension', () => {
    const fn = sanitizeFilename('../My File (Final).PDF');
    // Expect normalized lowercase extension and underscores
    assert.ok(fn.endsWith('.pdf'));
    assert.equal(fn.startsWith('..'), false);
    assert.match(fn, /^[A-Za-z0-9_-]+\.pdf$/);
  });

  it('limits base filename length to 100 chars', () => {
    const long = 'a'.repeat(150) + '.txt';
    const fn = sanitizeFilename(long);
    const base = fn.slice(0, fn.lastIndexOf('.'));
    assert.ok(base.length <= 100);
    assert.ok(fn.endsWith('.txt'));
  });

  it('rejects disallowed extensions', () => {
    const res = isAllowedFile({ name: 'evil.exe', type: 'application/octet-stream', size: 1 });
    assert.equal(res.allowed, false);
  });

  it('accepts allowed extension with empty or octet-stream mime', () => {
    const a = isAllowedFile({ name: 'data.csv', type: '', size: 10 });
    const b = isAllowedFile({ name: 'data.csv', type: 'application/octet-stream', size: 10 });
    assert.equal(a.allowed, true);
    assert.equal(b.allowed, true);
  });

  it('allows allowed mime even if not matching extension', () => {
    // Current policy: extension gating + mime whitelisting (not strict mapping)
    const res = isAllowedFile({ name: 'report.pdf', type: 'image/png', size: 10 });
    assert.equal(res.allowed, true);
  });
});
