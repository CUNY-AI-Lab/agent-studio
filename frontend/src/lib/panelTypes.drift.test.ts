// AS-3-7 / wave item 2 drift guard: the panel `type` union is restated in
// frontend/src/types.ts (WorkspacePanelBase.type) with no compile-time link to
// the canonical source, cloudflare/src/domain/workspace.ts's PANEL_TYPES. The
// frontend can't import the cloudflare module directly (separate workspace /
// tsconfig, and the union is a compile-time type with no runtime array over
// here), so — following the keyboardMap.drift.test.ts precedent — we read both
// source files and assert their panel-type literal sets are identical. A panel
// type added to one copy but not the other fails this test.
//
// The fourth copy lived in cloudflare/src/lib/legacy.ts; that file is deleted
// in this same wave, so this test tracks the two surviving copies.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../../..');

/** Pull every single-quoted literal out of a source fragment. */
function quotedLiterals(fragment: string): string[] {
  return [...fragment.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** Canonical: the PANEL_TYPES array in cloudflare/src/domain/workspace.ts. */
function canonicalPanelTypes(): string[] {
  const src = readFileSync(
    path.join(repoRoot, 'cloudflare/src/domain/workspace.ts'),
    'utf-8',
  );
  const match = src.match(/export const PANEL_TYPES = \[([\s\S]*?)\] as const;/);
  if (!match) {
    throw new Error(
      'Could not find `export const PANEL_TYPES = [...] as const;` in cloudflare/src/domain/workspace.ts',
    );
  }
  return quotedLiterals(match[1]);
}

/** The frontend copy: WorkspacePanelBase.type union in frontend/src/types.ts. */
function frontendPanelTypes(): string[] {
  const src = readFileSync(path.join(repoRoot, 'frontend/src/types.ts'), 'utf-8');
  const iface = src.match(/interface WorkspacePanelBase \{([\s\S]*?)\}/);
  if (!iface) {
    throw new Error('Could not find `interface WorkspacePanelBase {...}` in frontend/src/types.ts');
  }
  const typeLine = iface[1].match(/\btype:\s*([^;]+);/);
  if (!typeLine) {
    throw new Error('Could not find the `type:` union field in WorkspacePanelBase');
  }
  return quotedLiterals(typeLine[1]);
}

describe('frontend WorkspacePanelBase.type stays in sync with canonical PANEL_TYPES', () => {
  it('extracts a non-trivial set from each source (regex sanity)', () => {
    // Guards against a regex that silently matches nothing and passes vacuously.
    expect(canonicalPanelTypes().length).toBe(11);
    expect(frontendPanelTypes().length).toBe(11);
  });

  it('has no duplicate literals in either copy', () => {
    const canonical = canonicalPanelTypes();
    const frontend = frontendPanelTypes();
    expect(new Set(canonical).size).toBe(canonical.length);
    expect(new Set(frontend).size).toBe(frontend.length);
  });

  it('the two literal sets are identical', () => {
    const canonical = new Set(canonicalPanelTypes());
    const frontend = new Set(frontendPanelTypes());
    const missingFromFrontend = [...canonical].filter((t) => !frontend.has(t));
    const extraInFrontend = [...frontend].filter((t) => !canonical.has(t));
    expect(missingFromFrontend, 'panel types in PANEL_TYPES but missing from types.ts').toEqual([]);
    expect(extraInFrontend, 'panel types in types.ts but not in canonical PANEL_TYPES').toEqual([]);
  });
});
