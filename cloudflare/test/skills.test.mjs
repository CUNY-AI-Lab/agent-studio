// Tests for the research-skills library: index integrity, doc bundling,
// and the read_skill lookup semantics.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SKILLS, getSkill, getSkillContent, skillsPromptIndex } from '../src/skills/index.ts';
import { SKILL_DOCS } from '../src/skills/docs.generated.ts';

test('every bundled doc corresponds to a listed skill', () => {
  const names = new Set(SKILLS.map((skill) => skill.name));
  for (const docName of Object.keys(SKILL_DOCS)) {
    assert.ok(names.has(docName), `doc ${docName} has no SKILLS entry`);
  }
});

test('core research sources ship full reference docs', () => {
  for (const name of [
    'openalex',
    'crossref',
    'semantic-scholar',
    'arxiv',
    'pubmed',
    'primo',
    'worldcat',
    'libguides',
    'citation',
  ]) {
    const content = getSkillContent(name);
    assert.ok(content && content.length > 500, `${name} should have a substantial doc`);
  }
});

test('docs teach the codemode web-fetch path, not raw fetch or Bash', () => {
  for (const [name, doc] of Object.entries(SKILL_DOCS)) {
    if (['frontend-design', 'leaflet', 'citation'].includes(name)) continue;
    assert.match(doc, /codemode\.web_fetch/, `${name} should reference codemode.web_fetch`);
    assert.doesNotMatch(doc, /\bcurl\b|\bpython\b|\brequests\.get\b/i, `${name} should not reference Bash/Python tooling`);
  }
});

test('primo doc defers credentials to the host', () => {
  const doc = SKILL_DOCS.primo;
  assert.match(doc, /automatically attaches/i);
  assert.doesNotMatch(doc, /env\(/);
});

test('OAuth docs defer credentials to the host and never mention env()', () => {
  for (const name of ['worldcat', 'libguides']) {
    const doc = SKILL_DOCS[name];
    assert.match(doc, /handled by the host/i, `${name} should defer auth to the host`);
    assert.doesNotMatch(doc, /env\(/, `${name} should not reference env()`);
    // Not-configured fallback instruction must be present.
    assert.match(doc, /(not|isn't)\s+available\s+on\s+this\s+deployment/i, name);
  }
});

test('description-only skills fall back to their description', () => {
  const content = getSkillContent('wikipedia');
  assert.ok(content?.startsWith('# wikipedia'));
  assert.match(content, /Search Wikipedia/);
});

test('unknown skills return null and lookup is exact', () => {
  assert.equal(getSkillContent('nope'), null);
  assert.equal(getSkill('OpenAlex'), null);
});

test('prompt index is one line per skill', () => {
  const lines = skillsPromptIndex().split('\n');
  assert.equal(lines.length, SKILLS.length);
  assert.ok(lines.every((line) => line.startsWith('- ')));
});
