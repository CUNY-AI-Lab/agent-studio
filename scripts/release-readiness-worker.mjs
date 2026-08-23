const READINESS_PATH = '/readiness';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.pathname !== READINESS_PATH) {
      return new Response('Not Found', { status: 404 });
    }

    const readiness = await env.AGENT_STUDIO_READINESS.getReadiness();
    return Response.json(readiness, {
      headers: { 'Cache-Control': 'no-store' },
    });
  },
};
