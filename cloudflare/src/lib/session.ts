import { getCookie, setCookie } from 'hono/cookie';
import type { Context, MiddlewareHandler } from 'hono';
import { createOpaqueId } from './ids';
import type { Env } from '../env';

export const SESSION_COOKIE_NAME = 'agent-studio-session';

type SessionContext = Context<{
  Bindings: Env;
  Variables: { sessionId: string };
}>;

function hexToBuffer(value: string): ArrayBuffer {
  if (!/^[a-f0-9]+$/i.test(value) || value.length % 2 !== 0) {
    throw new Error('SESSION_SECRET must be an even-length hex string');
  }

  const buffer = new ArrayBuffer(value.length / 2);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < value.length; i += 2) {
    bytes[i / 2] = Number.parseInt(value.slice(i, i + 2), 16);
  }
  return buffer;
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    hexToBuffer(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function signValue(value: string, secret: string): Promise<string> {
  const key = await importSigningKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return `${value}.${bytesToHex(new Uint8Array(signature))}`;
}

async function verifySignedValue(value: string, secret: string): Promise<string | null> {
  const [sessionId, signature] = value.split('.');
  if (!sessionId || !signature) return null;
  if (!/^[a-f0-9]{32}$/i.test(sessionId)) return null;
  if (!/^[a-f0-9]{64}$/i.test(signature)) return null;

  const key = await importSigningKey(secret);
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    hexToBuffer(signature),
    new TextEncoder().encode(sessionId)
  );
  return ok ? sessionId : null;
}

export const sessionMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: { sessionId: string };
}> = async (c, next) => {
  const existing = getCookie(c, SESSION_COOKIE_NAME);
  const sessionSecret = c.env.SESSION_SECRET;

  if (!sessionSecret) {
    throw new Error('SESSION_SECRET is required');
  }

  let sessionId = existing ? await verifySignedValue(existing, sessionSecret) : null;
  if (!sessionId) {
    sessionId = createOpaqueId();
    const signed = await signValue(sessionId, sessionSecret);
    setCookie(c, SESSION_COOKIE_NAME, signed, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: new URL(c.req.url).protocol === 'https:',
      path: '/',
      maxAge: 60 * 60 * 24 * 7,
    });
  }

  c.set('sessionId', sessionId);
  await next();
};

export function requireSession(c: SessionContext): string {
  return c.get('sessionId');
}
