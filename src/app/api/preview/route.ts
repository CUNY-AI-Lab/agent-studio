import { NextRequest, NextResponse } from 'next/server';

// Simple in-memory cache for preview content (keyed by hash)
const previewCache = new Map<string, { content: string; expires: number }>();
const CACHE_TTL = 60 * 1000; // 1 minute
const MAX_CONTENT_SIZE = 5 * 1024 * 1024; // 5MB max preview content
const MAX_CACHE_ENTRIES = 100; // Max cached previews

// On-demand cache cleanup (avoid long-lived timers in serverless/runtime)
function cleanupCache() {
  const now = Date.now();
  // Remove expired
  for (const [key, value] of previewCache.entries()) {
    if (value.expires < now) previewCache.delete(key);
  }
  // Enforce max size by evicting oldest keys
  if (previewCache.size > MAX_CACHE_ENTRIES) {
    const toEvict = previewCache.size - MAX_CACHE_ENTRIES;
    let i = 0;
    for (const key of previewCache.keys()) {
      if (i++ >= toEvict) break;
      previewCache.delete(key);
    }
  }
}

// Simple hash function for content
function hashContent(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

// POST: Store preview content and return a key
export async function POST(request: NextRequest) {
  try {
    cleanupCache();
    const { content } = await request.json();
    if (!content || typeof content !== 'string') {
      return NextResponse.json({ error: 'Content required' }, { status: 400 });
    }

    // Validate content size to prevent memory exhaustion
    if (content.length > MAX_CONTENT_SIZE) {
      return NextResponse.json(
        { error: `Content too large. Maximum size is ${MAX_CONTENT_SIZE / 1024 / 1024}MB` },
        { status: 413 }
      );
    }

    // Enforce capacity and remove expired
    cleanupCache();

    const key = hashContent(content);
    previewCache.set(key, { content, expires: Date.now() + CACHE_TTL });

    return NextResponse.json({ key });
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}

// GET: Serve preview content with permissive headers
export async function GET(request: NextRequest) {
  const key = request.nextUrl.searchParams.get('key');
  if (!key) {
    return new NextResponse('Missing key', { status: 400 });
  }

  cleanupCache();
  const cached = previewCache.get(key);
  if (!cached || cached.expires < Date.now()) {
    return new NextResponse('Preview expired or not found', { status: 404 });
  }

  // Serve HTML with permissive CORS/COEP headers so maps can load tiles
  return new NextResponse(cached.content, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cross-Origin-Embedder-Policy': 'unsafe-none',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cross-Origin-Opener-Policy': 'unsafe-none',
      // Allow CDNs for scripts, styles, fonts while keeping frame isolation
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://unpkg.com https://cdn.jsdelivr.net https://esm.sh",
        "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://unpkg.com https://cdn.jsdelivr.net https://fonts.googleapis.com",
        "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com https://unpkg.com https://cdn.jsdelivr.net",
        "img-src 'self' data: blob: https: http:",
        "connect-src 'self' https: http:",
        "frame-ancestors 'self'",
      ].join('; '),
      'Referrer-Policy': 'no-referrer',
    },
  });
}
