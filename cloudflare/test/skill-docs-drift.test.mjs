import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSkillDocs } from '../../scripts/build-skill-docs.mjs';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

test('generated skill docs match markdown sources', async () => {
  const { content } = await buildSkillDocs(root);
  const committed = await readFile(
    path.join(root, 'cloudflare/src/skills/docs.generated.ts'),
    'utf-8',
  );
  assert.equal(content, committed);
});
