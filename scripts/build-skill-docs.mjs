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

// AS-3-9: the document caps are documented in prose in the skill markdown. Pull
// the real constants from document-tools.ts and interpolate them at build time
// so the docs can never drift from the enforced caps. Placeholders in the .md
// files use the {{CONST_NAME}} form. We read the constants out of the source
// with a regex rather than importing the .ts module so this script keeps
// running under plain `node` (no TS loader required).
const documentToolsSrc = await readFile(
  path.join(root, 'cloudflare/src/lib/document-tools.ts'),
  'utf-8',
);

function readNumericConst(name) {
  const match = documentToolsSrc.match(
    new RegExp(`export const ${name}\\s*=\\s*([0-9_]+)`),
  );
  if (!match) throw new Error(`Could not find export const ${name} in document-tools.ts`);
  return Number(match[1].replace(/_/g, ''));
}

const DOC_CAP_PLACEHOLDERS = {
  MAX_PDF_TEXT_CHARS: readNumericConst('MAX_PDF_TEXT_CHARS').toLocaleString('en-US'),
  MAX_PDF_PAGES: readNumericConst('MAX_PDF_PAGES').toLocaleString('en-US'),
  MAX_XLSX_ROWS: readNumericConst('MAX_XLSX_ROWS').toLocaleString('en-US'),
};

function interpolateCaps(content) {
  return content.replace(/\{\{(\w+)\}\}/g, (match, name) => {
    if (name in DOC_CAP_PLACEHOLDERS) return DOC_CAP_PLACEHOLDERS[name];
    throw new Error(`Unknown skill-doc placeholder ${match}`);
  });
}

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
  const raw = await readFile(path.join(docsDir, entry), 'utf-8');
  const content = interpolateCaps(raw);
  lines.push(`  ${JSON.stringify(name)}: ${JSON.stringify(content)},`);
}

lines.push('};', '');

await writeFile(outFile, lines.join('\n'));
console.log(`Wrote ${outFile} (${entries.length} docs)`);
