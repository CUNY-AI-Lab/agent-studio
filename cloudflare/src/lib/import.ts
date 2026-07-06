import { z } from 'zod';
import type { WorkspaceExportBundle } from './export';
import type { WorkspaceRecord } from '../domain/workspace';
import { CAIL_MODEL_ID_PATTERN } from './workspace-validation';

const scalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const panelLayoutSchema = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
}).strict();

const workspaceRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  galleryId: z.string().optional(),
  // Optional per-workspace model override. Export serializes the whole record
  // verbatim, so a workspace with a model override would otherwise fail the
  // .strict() parse on re-import. Same validation the PATCH route uses
  // (single source of truth for the pattern).
  model: z.string().regex(CAIL_MODEL_ID_PATTERN).max(200).optional(),
}).strict();

// AS-2-2 drift guard (compile-time). `workspaceRecordSchema` above is a
// hand-mirror of `WorkspaceRecord` (domain/workspace.ts). The original
// AS-2-2 bug was a field added to the interface but not the schema; the fix
// patched the field but left the *pattern* unguarded. This assertion fails
// `tsc --noEmit` if the two ever diverge in EITHER direction — a field/type
// added to one but not the other, an optionality mismatch, anything. It is a
// zero-runtime type-level check (see cloudflare/README pattern note).
//
// Why not `satisfies z.ZodType<WorkspaceRecord>`: that only proves the schema
// output is *assignable to* WorkspaceRecord (schema -> type). It would NOT
// catch WorkspaceRecord gaining a field the schema lacks (the exact AS-2-2
// shape). `TypesEqual` is the tuple-free bidirectional-identity idiom
// (https://github.com/microsoft/TypeScript/issues/27024) which catches drift
// both ways and treats optional properties exactly. The regex/max on `model`
// are runtime-only refinements; they don't appear in `z.infer`, so the
// inferred shape is still `model?: string` and equality holds.
type TypesEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
// If this line errors, the schema and WorkspaceRecord have drifted. Reconcile
// the two definitions; do NOT `as`-cast this away.
const _workspaceRecordSchemaMatchesDomain: TypesEqual<
  z.infer<typeof workspaceRecordSchema>,
  WorkspaceRecord
> = true;
void _workspaceRecordSchemaMatchesDomain;

const panelBaseSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  layout: panelLayoutSchema.optional(),
  sourcePanelId: z.string().optional(),
});

export const panelSchema = z.discriminatedUnion('type', [
  panelBaseSchema.extend({
    type: z.literal('chat'),
  }).strict(),
  panelBaseSchema.extend({
    type: z.literal('fileTree'),
  }).strict(),
  panelBaseSchema.extend({
    type: z.literal('markdown'),
    content: z.string(),
  }).strict(),
  panelBaseSchema.extend({
    type: z.literal('table'),
    columns: z.array(z.object({ key: z.string(), label: z.string() }).strict()),
    rows: z.array(z.record(z.string(), scalarSchema)),
  }).strict(),
  panelBaseSchema.extend({
    type: z.literal('chart'),
    chartType: z.enum(['bar', 'line', 'pie', 'area']),
    data: z.array(z.record(z.string(), scalarSchema)),
  }).strict(),
  panelBaseSchema.extend({
    type: z.literal('cards'),
    items: z.array(z.object({
      id: z.string().optional(),
      title: z.string(),
      subtitle: z.string().optional(),
      description: z.string().optional(),
      badge: z.string().optional(),
      metadata: z.record(z.string(), z.string()).optional(),
    }).strict()),
  }).strict(),
  panelBaseSchema.extend({
    type: z.literal('pdf'),
    filePath: z.string(),
  }).strict(),
  panelBaseSchema.extend({
    type: z.literal('preview'),
    filePath: z.string().optional(),
    content: z.string().optional(),
  }).strict(),
  panelBaseSchema.extend({
    type: z.literal('editor'),
    filePath: z.string(),
  }).strict(),
  panelBaseSchema.extend({
    type: z.literal('file'),
    filePath: z.string(),
  }).strict(),
  panelBaseSchema.extend({
    type: z.literal('detail'),
    linkedTo: z.string().optional(),
  }).strict(),
]);

const workspaceStateSchema = z.object({
  sessionId: z.string().nullable(),
  workspace: workspaceRecordSchema.nullable(),
  panels: z.array(panelSchema),
  viewport: z.object({
    x: z.number(),
    y: z.number(),
    zoom: z.number(),
  }).strict(),
  groups: z.array(z.object({
    id: z.string(),
    name: z.string().optional(),
    panelIds: z.array(z.string()),
    color: z.string().optional(),
  }).strict()),
  connections: z.array(z.object({
    id: z.string(),
    sourceId: z.string(),
    targetId: z.string(),
  }).strict()),
}).strict();

const workspaceExportFileSchema = z.object({
  path: z.string().min(1),
  size: z.number().optional(),
  uploadedAt: z.string().optional(),
  etag: z.string().optional(),
  contentType: z.string(),
  encoding: z.enum(['utf8', 'base64']),
  content: z.string(),
}).strict();

export const workspaceImportBundleSchema = z.object({
  version: z.literal(1),
  exportedAt: z.string(),
  workspace: workspaceRecordSchema,
  state: workspaceStateSchema,
  messages: z.array(z.any()),
  files: z.array(workspaceExportFileSchema),
}).strict();

export function parseWorkspaceImportBundle(payload: unknown): WorkspaceExportBundle {
  return workspaceImportBundleSchema.parse(payload) as WorkspaceExportBundle;
}

export function decodeWorkspaceImportFile(file: WorkspaceExportBundle['files'][number]): string | Uint8Array {
  if (file.encoding === 'utf8') {
    return file.content;
  }

  const binary = atob(file.content);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
