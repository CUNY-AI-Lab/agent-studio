import { z } from 'zod';

// Only accept Workers AI catalog ids (`@cf/...`). Anything else is rejected 400
// by the PATCH route. Kept in its own module so it is testable without pulling
// in the full Worker (server.ts uses `cloudflare:` imports node can't load).
export const CAIL_MODEL_ID_PATTERN = /^@cf\/[\w.\/-]+$/;

export const patchWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  model: z.string().regex(CAIL_MODEL_ID_PATTERN).max(200).optional(),
});
