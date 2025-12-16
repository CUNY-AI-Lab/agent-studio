import { cookies } from 'next/headers';
import { randomBytes, createHmac } from 'crypto';

const CSRF_SECRET = process.env.CSRF_SECRET || 'default-csrf-secret-change-in-production';
const CSRF_COOKIE_NAME = 'csrf-token';
const CSRF_HEADER_NAME = 'x-csrf-token';

// Generate a CSRF token
export async function generateCsrfToken(): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const signature = createHmac('sha256', CSRF_SECRET).update(token).digest('hex');
  return `${token}.${signature}`;
}

// Validate a CSRF token
export function validateCsrfToken(token: string): boolean {
  if (!token || typeof token !== 'string') return false;

  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const [tokenValue, signature] = parts;
  const expectedSignature = createHmac('sha256', CSRF_SECRET).update(tokenValue).digest('hex');

  // Constant-time comparison
  if (signature.length !== expectedSignature.length) return false;
  let result = 0;
  for (let i = 0; i < signature.length; i++) {
    result |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
  }
  return result === 0;
}

// Get CSRF token from cookie or generate new one
export async function getCsrfToken(): Promise<string> {
  const cookieStore = await cookies();
  const existing = cookieStore.get(CSRF_COOKIE_NAME)?.value;

  if (existing && validateCsrfToken(existing)) {
    return existing;
  }

  return generateCsrfToken();
}

// Verify CSRF token from request header matches cookie
export async function verifyCsrfToken(headerToken: string | null): Promise<boolean> {
  if (!headerToken) return false;

  const cookieStore = await cookies();
  const cookieToken = cookieStore.get(CSRF_COOKIE_NAME)?.value;

  if (!cookieToken) return false;

  // Both tokens must be valid and match
  return validateCsrfToken(headerToken) &&
         validateCsrfToken(cookieToken) &&
         headerToken === cookieToken;
}

// Helper to set CSRF cookie
export function getCsrfCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === 'true',
    sameSite: 'strict' as const,
    path: '/',
    maxAge: 60 * 60 * 24, // 24 hours
  };
}

export { CSRF_COOKIE_NAME, CSRF_HEADER_NAME };
