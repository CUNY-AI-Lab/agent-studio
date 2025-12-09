import { NextRequest, NextResponse } from 'next/server';

// Simple in-memory cache for preview content (keyed by hash)
const previewCache = new Map<string, { content: string; expires: number }>();
const CACHE_TTL = 60 * 1000; // 1 minute
const MAX_CONTENT_SIZE = 5 * 1024 * 1024; // 5MB max preview content
const MAX_CACHE_ENTRIES = 100; // Max cached previews

// Clean expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of previewCache.entries()) {
    if (value.expires < now) {
      previewCache.delete(key);
    }
  }
}, 30 * 1000);

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

    // Evict oldest entries if cache is full
    if (previewCache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = previewCache.keys().next().value;
      if (oldestKey) previewCache.delete(oldestKey);
    }

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
    },
  });
}
