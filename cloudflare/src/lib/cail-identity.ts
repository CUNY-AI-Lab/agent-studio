/**
 * CAIL gateway identity (CUNYLogin SSO) for the Agent Studio worker.
 *
 * The OpenResty SSO gate on tools.ailab.gc.cuny.edu injects X-CAIL-* headers
 * after authentication. This worker is also directly reachable on its
 * workers.dev URL, so bare X-CAIL-* headers prove nothing — anyone can set
 * them. Identity is accepted ONLY from a X-CAIL-Identity-JWT that verifies
 * against the shared secret.
 *
 * Contract (see cail-gateway docs/INTEGRATION.md and
 * key-service/src/identity.ts): HS256 with a pinned algorithm, aud
 * "cail-internal", iss ending "/cail-sso", exp enforced. The stable
 * pseudonymous `subject` ("cail-<hex>") is the only durable key for
 * per-user data — never key anything by email.
 *
 * If CAIL_IDENTITY_JWT_SECRET is unset, identity is disabled and every
 * request is anonymous (pre-rollout behavior). CAIL_REQUIRE_IDENTITY="true"
 * makes model calls fail closed: requests without a verified identity JWT
 * get 401. Flip it (with the secret set) at the same time
 * CAIL_SSO_MODE=enforce lands on the gateway.
 */

export const CAIL_IDENTITY_HEADER = 'X-CAIL-Identity-JWT';
export const CAIL_APP_SLUG = 'agent-studio';

const JWT_AUDIENCE = 'cail-internal';
const ISS_SUFFIX = '/cail-sso';

export interface CailIdentity {
  /** Stable pseudonymous CAIL subject ("cail-<hex>"). The only durable key. */
  subject: string;
  email?: string;
  name?: string;
  entitlements: string[];
}

export interface CailIdentityEnv {
  CAIL_IDENTITY_JWT_SECRET?: string;
  CAIL_REQUIRE_IDENTITY?: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64UrlDecode(segment: string): Uint8Array<ArrayBuffer> | null {
  try {
    const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Verify a raw X-CAIL-Identity-JWT string against the shared secret.
 * Returns the identity, or null when the token is missing/invalid/expired.
 * Never throws. Pins HS256 — the token never picks its own algorithm.
 */
export async function verifyIdentityJwt(
  token: string | null | undefined,
  secret: string | undefined,
  now: number = Math.floor(Date.now() / 1000),
): Promise<CailIdentity | null> {
  if (!secret || !token) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;

  const headerBytes = base64UrlDecode(headerB64);
  const payloadBytes = base64UrlDecode(payloadB64);
  const signature = base64UrlDecode(signatureB64);
  if (!headerBytes || !payloadBytes || !signature) return null;

  let header: { alg?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(decoder.decode(headerBytes));
    payload = JSON.parse(decoder.decode(payloadBytes));
  } catch {
    return null;
  }
  // Pin the algorithm — never let the token pick it.
  if (header.alg !== 'HS256') return null;

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    signature,
    encoder.encode(`${headerB64}.${payloadB64}`),
  );
  if (!valid) return null;

  if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
  if (payload.aud !== JWT_AUDIENCE) return null;
  if (typeof payload.iss !== 'string' || !payload.iss.endsWith(ISS_SUFFIX)) return null;
  if (typeof payload.sub !== 'string' || payload.sub === '') return null;

  return {
    subject: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    name: typeof payload.name === 'string' ? payload.name : undefined,
    entitlements: Array.isArray(payload.entitlements)
      ? payload.entitlements.filter((e): e is string => typeof e === 'string')
      : [],
  };
}

/**
 * Read and verify the identity JWT from a request. Returns both the raw token
 * (which model calls forward to the proxy as the caller's credential) and the
 * verified identity, or null when the request is anonymous / the token fails.
 */
export async function getCailIdentityFromRequest(
  request: Request,
  env: CailIdentityEnv,
  now?: number,
): Promise<{ token: string; identity: CailIdentity } | null> {
  const token = request.headers.get(CAIL_IDENTITY_HEADER);
  if (!token) return null;
  const identity = await verifyIdentityJwt(token, env.CAIL_IDENTITY_JWT_SECRET, now);
  if (!identity) return null;
  return { token, identity };
}

/**
 * True when the worker must reject anonymous requests to model/spend paths
 * (401). If the flag is on but the secret is missing, every identity check
 * fails and those paths close — never open — by misconfiguration.
 */
export function cailIdentityRequired(env: CailIdentityEnv): boolean {
  return env.CAIL_REQUIRE_IDENTITY === 'true';
}

/**
 * 401 body matching the CAIL error envelope so the same-origin frontend's
 * auth handling redirects to /login?rt=<path> like the other tools.
 */
export function cailAuthRequiredResponse(loginPath = '/login'): Response {
  return new Response(
    JSON.stringify({
      error: 'authentication_required',
      login_url: loginPath,
      message:
        'Sign in with CUNY Login at https://tools.ailab.gc.cuny.edu to use Agent Studio.',
    }),
    {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer realm="CAIL"',
      },
    },
  );
}
