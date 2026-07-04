import { describe, expect, it } from 'vitest';
import { clampNumber, formatFileSize, formatRuntimeValue, makeClientId } from './format';

describe('clampNumber', () => {
  it('clamps to the range', () => {
    expect(clampNumber(5, 0, 10)).toBe(5);
    expect(clampNumber(-1, 0, 10)).toBe(0);
    expect(clampNumber(99, 0, 10)).toBe(10);
  });
});

describe('formatFileSize', () => {
  it('formats bytes, kilobytes, and megabytes', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });

  it('treats missing size as zero', () => {
    expect(formatFileSize(undefined)).toBe('0 B');
  });
});

describe('formatRuntimeValue', () => {
  it('passes strings through and pretty-prints objects', () => {
    expect(formatRuntimeValue('hi')).toBe('hi');
    expect(formatRuntimeValue({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(formatRuntimeValue(undefined)).toBe('undefined');
  });

  it('falls back to String() for non-serializable values', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatRuntimeValue(circular)).toBe('[object Object]');
  });
});

describe('makeClientId', () => {
  it('prefixes and produces unique ids', () => {
    const a = makeClientId('conn');
    const b = makeClientId('conn');
    expect(a.startsWith('conn-')).toBe(true);
    expect(a).not.toBe(b);
  });
});
