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
const scriptPath = fileURLToPath(import.meta.url);

// AS-3-9: the document caps are documented in prose in the skill markdown. Pull
// the real constants from document-tools.ts and interpolate them at build time
// so the docs can never drift from the enforced caps. Placeholders in the .md
// files use the {{CONST_NAME}} form. We read the constants out of the source
// with a regex rather than importing the .ts module so this script keeps
// running under plain `node` (no TS loader required).
export function readNumericConst(documentToolsSrc, name) {
  const match = documentToolsSrc.match(
    new RegExp(`export const ${name}\\s*=\\s*([0-9_]+)`),
  );
  if (!match) throw new Error(`Could not find export const ${name} in document-tools.ts`);
  return Number(match[1].replace(/_/g, ''));
}

export function docCapPlaceholders(documentToolsSrc) {
  return {
    MAX_PDF_TEXT_CHARS: readNumericConst(documentToolsSrc, 'MAX_PDF_TEXT_CHARS').toLocaleString('en-US'),
    MAX_PDF_PAGES: readNumericConst(documentToolsSrc, 'MAX_PDF_PAGES').toLocaleString('en-US'),
    MAX_XLSX_ROWS: readNumericConst(documentToolsSrc, 'MAX_XLSX_ROWS').toLocaleString('en-US'),
  };
}

export function interpolateCaps(content, placeholders) {
  return content.replace(/\{\{(\w+)\}\}/g, (match, name) => {
    if (name in placeholders) return placeholders[name];
    throw new Error(`Unknown skill-doc placeholder ${match}`);
  });
}

export function renderSkillDocs(entries) {
  const lines = [
    '// GENERATED FILE — do not edit by hand.',
    '// Source of truth: cloudflare/src/skills/docs/*.md',
    '// Regenerate with: node scripts/build-skill-docs.mjs',
    '',
    'export const SKILL_DOCS: Record<string, string> = {',
  ];
  for (const { name, content } of entries) {
    lines.push(`  ${JSON.stringify(name)}: ${JSON.stringify(content)},`);
  }
  lines.push('};', '');
  return lines.join('\n');
}

export async function buildSkillDocs(rootDir = root) {
  const docsDir = path.join(rootDir, 'cloudflare/src/skills/docs');
  const documentToolsSrc = await readFile(
    path.join(rootDir, 'cloudflare/src/lib/document-tools.ts'),
    'utf-8',
  );
  const placeholders = docCapPlaceholders(documentToolsSrc);
  const docEntries = [];
  const entries = (await readdir(docsDir)).filter((name) => name.endsWith('.md')).sort();
  for (const entry of entries) {
    const name = entry.replace(/\.md$/, '');
    const raw = await readFile(path.join(docsDir, entry), 'utf-8');
    const content = interpolateCaps(raw, placeholders);
    docEntries.push({ name, content });
  }
  return {
    content: renderSkillDocs(docEntries),
    count: entries.length,
    outFile: path.join(rootDir, 'cloudflare/src/skills/docs.generated.ts'),
  };
}

async function main() {
  const { content, count, outFile } = await buildSkillDocs(root);
  await writeFile(outFile, content);
  console.log(`Wrote ${outFile} (${count} docs)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await main();
}
