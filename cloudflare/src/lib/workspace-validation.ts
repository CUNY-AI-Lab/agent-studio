import { z } from 'zod';

// Only accept CAIL catalog ids: Workers AI (`@cf/...`) or the gateway's
// OpenRouter namespace (`cail/...`, e.g. `cail/gpt-4.1-nano`). Anything else is
// rejected 400 by the PATCH route. Kept in its own module so it is testable
// without pulling in the full Worker (server.ts uses `cloudflare:` imports
// node can't load).
export const CAIL_MODEL_ID_PATTERN = /^(@cf|cail)\/[\w.\/-]+$/;

export const patchWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  model: z.string().regex(CAIL_MODEL_ID_PATTERN).max(200).optional(),
});

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
  viewport: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    zoom: z.number().finite(),
  }).strict().optional(),
}).strict();
