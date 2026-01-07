import { NextRequest, NextResponse } from 'next/server';

const SESSION_SECRET = process.env.SESSION_SECRET || 'default-session-secret-change-in-production';
const CSRF_SECRET = process.env.CSRF_SECRET || 'default-csrf-secret-change-in-production';
if (process.env.NODE_ENV === 'production') {
  if (!process.env.SESSION_SECRET || SESSION_SECRET === 'default-session-secret-change-in-production') {
    throw new Error('SESSION_SECRET must be set in production');
  }
  if (!process.env.CSRF_SECRET || CSRF_SECRET === 'default-csrf-secret-change-in-production') {
    throw new Error('CSRF_SECRET must be set in production');
  }
}
const CSRF_HEADER_NAME = 'x-csrf-token';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds
const CSRF_COOKIE_NAME = 'csrf-token';

// Simple in-memory rate limiter (per IP)
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 60; // 60 requests per minute

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }

  entry.count++;
  return true;
}

// Opportunistic cleanup to avoid long-lived timers in middleware
function cleanupRateLimit() {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap.entries()) {
    if (now > entry.resetTime) rateLimitMap.delete(ip);
  }
}

// Generate a signed session ID using Web Crypto API (Edge-compatible)
async function generateSignedSession(): Promise<string> {
  const sessionBytes = new Uint8Array(16);
  crypto.getRandomValues(sessionBytes);
  const sessionId = Array.from(sessionBytes).map(b => b.toString(16).padStart(2, '0')).join('');

  // Create HMAC signature
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(sessionId));
  const signature = Array.from(new Uint8Array(signatureBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return `${sessionId}.${signature}`;
}

// Validate a signed session ID
async function validateSignedSession(signedSession: string): Promise<string | null> {
  if (!signedSession || typeof signedSession !== 'string') return null;

  const parts = signedSession.split('.');
  if (parts.length !== 2) return null;

  const [sessionId, signature] = parts;

  // Validate session ID format (32-char hex string)
  if (!/^[a-f0-9]+$/.test(sessionId) || sessionId.length !== 32) {
    return null;
  }

  // Recompute the expected signature
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const expectedBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(sessionId));
  const expectedSignature = Array.from(new Uint8Array(expectedBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time comparison
  if (signature.length !== expectedSignature.length) return null;
  let result = 0;
  for (let i = 0; i < signature.length; i++) {
    result |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
  }
  return result === 0 ? sessionId : null;
}

// Generate a CSRF token using Web Crypto API (Edge-compatible)
async function generateCsrfToken(): Promise<string> {
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = Array.from(tokenBytes).map(b => b.toString(16).padStart(2, '0')).join('');

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(CSRF_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(token));
  const signature = Array.from(new Uint8Array(signatureBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return `${token}.${signature}`;
}

// Validate a CSRF token using Web Crypto API (Edge-compatible)
async function validateCsrfToken(tokenString: string): Promise<boolean> {
  if (!tokenString || typeof tokenString !== 'string') return false;

  const parts = tokenString.split('.');
  if (parts.length !== 2) return false;

  const [token, signature] = parts;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(CSRF_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const expectedBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(token));
  const expectedSignature = Array.from(new Uint8Array(expectedBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time comparison
  if (signature.length !== expectedSignature.length) return false;
  let result = 0;
  for (let i = 0; i < signature.length; i++) {
    result |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
  }
  return result === 0;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const response = NextResponse.next();

  // Opportunistically clean expired rate limit entries
  cleanupRateLimit();

  // Get client IP for rate limiting
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
             request.headers.get('x-real-ip') ||
             'unknown';

  // Handle session cookie - validate existing or create new signed session
  const existingSession = request.cookies.get('agent-studio-session')?.value;
  let needsNewSession = true;

  if (existingSession) {
    const validSessionId = await validateSignedSession(existingSession);
    if (validSessionId) {
      needsNewSession = false;
    }
  }

  if (needsNewSession) {
    const newSignedSession = await generateSignedSession();
    const secureCookie = process.env.COOKIE_SECURE
      ? process.env.COOKIE_SECURE === 'true'
      : process.env.NODE_ENV === 'production';
    response.cookies.set('agent-studio-session', newSignedSession, {
      httpOnly: true,
      secure: secureCookie,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_MAX_AGE,
    });
  }

  // Handle CSRF token cookie
  const existingCsrfToken = request.cookies.get(CSRF_COOKIE_NAME)?.value;
  let csrfToken = existingCsrfToken;

  if (!existingCsrfToken || !(await validateCsrfToken(existingCsrfToken))) {
    csrfToken = await generateCsrfToken();
    const secureCookie = process.env.COOKIE_SECURE
      ? process.env.COOKIE_SECURE === 'true'
      : process.env.NODE_ENV === 'production';
    response.cookies.set(CSRF_COOKIE_NAME, csrfToken, {
      httpOnly: false, // Needs to be readable by JS to send in header
      secure: secureCookie,
      sameSite: 'strict',
      path: '/',
      maxAge: 60 * 60 * 24, // 24 hours
    });
  }

  // Only apply rate limiting and CSRF to API routes
  if (!pathname.startsWith('/api')) {
    return response;
  }

  // Rate limiting (stricter for query endpoint)
  const isQueryEndpoint = pathname.includes('/query');
  const maxRequests = isQueryEndpoint ? 20 : RATE_LIMIT_MAX_REQUESTS;

  if (isQueryEndpoint) {
    const queryEntry = rateLimitMap.get(`query:${ip}`);
    const now = Date.now();
    if (!queryEntry || now > queryEntry.resetTime) {
      rateLimitMap.set(`query:${ip}`, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    } else if (queryEntry.count >= maxRequests) {
      return NextResponse.json(
        { error: 'Rate limit exceeded. Please slow down.' },
        { status: 429 }
      );
    } else {
      queryEntry.count++;
    }
  } else if (!checkRateLimit(ip)) {
    return NextResponse.json(
      { error: 'Rate limit exceeded' },
      { status: 429 }
    );
  }

  // Skip CSRF for safe methods and specific endpoints
  const safeMethod = ['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  const skipCsrfPaths = ['/api/csrf', '/api/preview', '/api/create'];

  if (safeMethod || skipCsrfPaths.some(p => pathname.startsWith(p))) {
    return response;
  }

  // CSRF validation for mutating requests
  const headerToken = request.headers.get(CSRF_HEADER_NAME);

  // Skip CSRF check for form submissions (they use SameSite cookie protection)
  const contentType = request.headers.get('content-type') || '';
  const isFormSubmission = contentType.includes('multipart/form-data') ||
                           contentType.includes('application/x-www-form-urlencoded');

  // For JSON APIs, require CSRF token
  if (!isFormSubmission) {
    if (!headerToken || !(await validateCsrfToken(headerToken))) {
      return NextResponse.json(
        { error: 'Invalid or missing CSRF token' },
        { status: 403 }
      );
    }
  }

  return response;
}

export const config = {
  matcher: [
    // Match all routes except static files
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
