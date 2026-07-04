// Regenerates cloudflare/src/skills/docs.generated.ts from the markdown
// docs in cloudflare/src/skills/docs/. The generated file is checked in so
// the worker bundle, typecheck, and node:test all work without custom
// loaders or wrangler text-module rules. Run after editing any skill doc:
//
//   node scripts/build-skill-docs.mjs

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const docsDir = path.join(root, 'cloudflare/src/skills/docs');
const outFile = path.join(root, 'cloudflare/src/skills/docs.generated.ts');

const entries = (await readdir(docsDir)).filter((name) => name.endsWith('.md')).sort();

const lines = [
  '// GENERATED FILE — do not edit by hand.',
  '// Source of truth: cloudflare/src/skills/docs/*.md',
  '// Regenerate with: node scripts/build-skill-docs.mjs',
  '',
  'export const SKILL_DOCS: Record<string, string> = {',
];

for (const entry of entries) {
  const name = entry.replace(/\.md$/, '');
  const content = await readFile(path.join(docsDir, entry), 'utf-8');
  lines.push(`  ${JSON.stringify(name)}: ${JSON.stringify(content)},`);
}

lines.push('};', '');

await writeFile(outFile, lines.join('\n'));
console.log(`Wrote ${outFile} (${entries.length} docs)`);
