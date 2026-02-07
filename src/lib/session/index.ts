import { cookies } from 'next/headers';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import { createHmac, randomBytes } from 'crypto';

const DATA_DIR = process.env.DATA_DIR || 'data';
const SESSION_SECRET = process.env.SESSION_SECRET || 'default-session-secret-change-in-production';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

if (process.env.NODE_ENV === 'production') {
  if (!process.env.SESSION_SECRET || SESSION_SECRET === 'default-session-secret-change-in-production') {
    throw new Error('SESSION_SECRET must be set in production');
  }
}


// Sign a session ID
function signSessionId(sessionId: string): string {
  const signature = createHmac('sha256', SESSION_SECRET)
    .update(sessionId)
    .digest('hex');
  return `${sessionId}.${signature}`;
}

// Verify and extract session ID from signed token
function verifySessionId(signedToken: string): string | null {
  if (!signedToken || typeof signedToken !== 'string') return null;

  const parts = signedToken.split('.');
  if (parts.length !== 2) return null;

  const [sessionId, signature] = parts;

  // Validate session ID format (32-char hex string from proxy.ts)
  if (!/^[a-f0-9]+$/.test(sessionId) || sessionId.length !== 32) {
    return null;
  }

  const expectedSignature = createHmac('sha256', SESSION_SECRET)
    .update(sessionId)
    .digest('hex');

  // Constant-time comparison
  if (signature.length !== expectedSignature.length) return null;

  let result = 0;
  for (let i = 0; i < signature.length; i++) {
    result |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
  }

  return result === 0 ? sessionId : null;
}


export async function getSession(): Promise<string> {
  return getOrCreateSession();
}

// Get existing session or create a new one if invalid/missing
export async function getOrCreateSession(): Promise<string> {
  const cookieStore = await cookies();
  const signedSession = cookieStore.get('agent-studio-session')?.value;

  // Try to verify existing session
  if (signedSession) {
    const sessionId = verifySessionId(signedSession);
    if (sessionId) {
      // Ensure user directory exists
      const userDir = join(process.cwd(), DATA_DIR, 'users', sessionId, 'workspaces');
      await mkdir(userDir, { recursive: true });
      return sessionId;
    }
  }

  // No valid session - create a new one
  const { value, sessionId } = createSignedSession();
  cookieStore.set('agent-studio-session', value, getSessionCookieOptions());

  // Ensure user directory exists
  const userDir = join(process.cwd(), DATA_DIR, 'users', sessionId, 'workspaces');
  await mkdir(userDir, { recursive: true });

  return sessionId;
}

// Create a new signed session
export function createSignedSession(): { value: string; sessionId: string } {
  const sessionId = randomBytes(16).toString('hex');
  const signedValue = signSessionId(sessionId);
  return { value: signedValue, sessionId };
}

// Get session cookie options
export function getSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_MAX_AGE / 1000, // in seconds
  };
}

export function getUserDataPath(sessionId: string): string {
  // Validate session ID format to prevent path traversal (32-char hex string)
  if (!/^[a-f0-9]+$/.test(sessionId) || sessionId.length !== 32) {
    throw new Error('Invalid session ID');
  }
  return join(process.cwd(), DATA_DIR, 'users', sessionId);
}
