import { z } from 'zod/mini';

const READINESS_PATH = '/readiness';
const MAX_METADATA_LENGTH = 128;
const metadataSchema = z.string().check(
  z.minLength(1),
  z.maxLength(MAX_METADATA_LENGTH),
  z.regex(/^[\x21-\x7e]+$/),
);
const readinessSchema = z.strictObject({
  ok: z.literal(true),
  service: z.literal('agent-studio'),
  configuration: z.literal('ready'),
  version_id: metadataSchema,
  tag: metadataSchema,
});
const FAILURE = {
  ok: false,
  service: 'agent-studio',
  configuration: 'not_ready',
  version_id: null,
  tag: null,
};

function failureResponse() {
  return Response.json(FAILURE, {
    status: 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.pathname !== READINESS_PATH) {
      return new Response('Not Found', { status: 404 });
    }

    try {
      const readiness = await env.AGENT_STUDIO_READINESS.getReadiness();
      const parsed = z.safeParse(readinessSchema, readiness);
      if (!parsed.success) {
        return failureResponse();
      }
      const { version_id, tag } = parsed.data;

      return Response.json({
        ok: true,
        service: 'agent-studio',
        configuration: 'ready',
        version_id,
        tag,
      }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    } catch {
      return failureResponse();
    }
  },
};
