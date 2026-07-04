// Drift check: every shortcut in the canonical keyboardMap must appear in
// ACCESSIBILITY.md's hand-maintained tables. Fails the suite when the doc and
// the in-app dialog's source diverge (the "single source of truth" guarantee).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { KEYBOARD_SHORTCUT_GROUPS } from './keyboardMap';

const md = readFileSync(
  path.resolve(__dirname, '../../../ACCESSIBILITY.md'),
  'utf-8'
);

// The md wraps key combos in backticks and may split "A / B" into
// `A` / `B` — compare on the normalized text with backticks stripped.
const normalized = md.replace(/`/g, '').toLowerCase();

describe('ACCESSIBILITY.md stays in sync with keyboardMap', () => {
  for (const group of KEYBOARD_SHORTCUT_GROUPS) {
    for (const shortcut of group.shortcuts) {
      it(`documents "${shortcut.keys}" (${group.title})`, () => {
        expect(normalized).toContain(shortcut.keys.toLowerCase());
      });
    }
  }
});
