// AS-3-7 drift guard: the panel `type` enum is restated in several
// hand-maintained places (the domain WorkspacePanelBase union, the import.ts
// zod discriminatedUnion, the workspace-agent switch, the frontend types.ts).
// PANEL_TYPES in domain/workspace.ts is the canonical source of truth; this
// test fails if the import.ts discriminatedUnion's literal set diverges from it,
// so a new panel type can't land in one copy but silently miss another.
//
// The domain union itself is kept in lockstep with PANEL_TYPES at compile time
// (WorkspacePanelBase.type is typed as PanelType = PANEL_TYPES[number]), so the
// only runtime-checkable copy left is the zod schema — that's what we assert.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PANEL_TYPES } from '../src/domain/workspace.ts';
import { panelSchema } from '../src/lib/import.ts';

/** Pull the discriminator literal set out of a zod v4 discriminatedUnion. */
function zodDiscriminatorLiterals(schema) {
  const def = schema.def ?? schema._def;
  const literals = [];
  for (const option of def.options) {
    const optionDef = option.def ?? option._def;
    const typeField = optionDef.shape.type;
    const typeDef = typeField.def ?? typeField._def;
    // z.literal('x') stores its value(s) under `values` in zod v4.
    literals.push(...typeDef.values);
  }
  return literals;
}

test('import.ts panel discriminatedUnion matches the canonical PANEL_TYPES', () => {
  const canonical = new Set(PANEL_TYPES);
  const schemaLiterals = zodDiscriminatorLiterals(panelSchema);
  const schemaSet = new Set(schemaLiterals);

  // No duplicates in the schema (each type appears exactly once).
  assert.equal(
    schemaLiterals.length,
    schemaSet.size,
    'import.ts discriminatedUnion has a duplicate panel type literal',
  );

  const missingFromSchema = [...canonical].filter((t) => !schemaSet.has(t));
  const extraInSchema = [...schemaSet].filter((t) => !canonical.has(t));

  assert.deepEqual(
    missingFromSchema,
    [],
    `panel types in PANEL_TYPES but missing from import.ts schema: ${missingFromSchema.join(', ')}`,
  );
  assert.deepEqual(
    extraInSchema,
    [],
    `panel types in import.ts schema but not in canonical PANEL_TYPES: ${extraInSchema.join(', ')}`,
  );
});
