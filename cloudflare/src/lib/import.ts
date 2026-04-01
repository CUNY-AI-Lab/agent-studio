import { z } from 'zod';
import type { WorkspaceExportBundle } from './export';

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
}).strict();

const panelBaseSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  layout: panelLayoutSchema.optional(),
  sourcePanelId: z.string().optional(),
});

const panelSchema = z.discriminatedUnion('type', [
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
