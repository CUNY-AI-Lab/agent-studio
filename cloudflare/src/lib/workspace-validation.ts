import { z } from 'zod';

// Gateway accepts prefix-free IDs, preserving the complete model variant.
export const CAIL_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const allowedModelIdSchema = z.string().max(200).regex(CAIL_MODEL_ID_PATTERN);

export function isAllowedCailModelId(value: string | null | undefined): value is string {
  return allowedModelIdSchema.safeParse(value).success;
}

export const patchWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  model: z.string().regex(CAIL_MODEL_ID_PATTERN).max(200).optional(),
});

/** Human-readable titles produced by the model; matches persisted workspace names. */
export const workspaceTitleSchema = z.string().trim().min(1).max(200);

export const runtimeCodeSchema = z.string().trim().min(1).max(100_000);
export const panelIdSchema = z.string().trim().min(1).max(200);

export const layoutPatchSchema = z.object({
  panels: z.record(z.string(), z.object({
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    width: z.number().finite().optional(),
    height: z.number().finite().optional(),
  }).strict()).optional(),
  groups: z.array(z.object({
    id: panelIdSchema,
    name: z.string().max(200).optional(),
    panelIds: z.array(panelIdSchema).max(500),
    color: z.string().max(100).optional(),
  }).strict()).max(500).optional(),
  removeGroups: z.array(panelIdSchema).max(500).optional(),
  connections: z.array(z.object({
    id: panelIdSchema,
    sourceId: panelIdSchema,
    targetId: panelIdSchema,
  }).strict()).max(1000).optional(),
  removeConnections: z.array(panelIdSchema).max(1000).optional(),
  viewport: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    zoom: z.number().finite(),
  }).strict().optional(),
}).strict();
