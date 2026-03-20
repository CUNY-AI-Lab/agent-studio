import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { createSandboxedStorage } from '@/lib/storage';

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.zip': 'application/zip',
};

const HTML_PREVIEW_HEADERS = {
  'Cross-Origin-Embedder-Policy': 'unsafe-none',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Cross-Origin-Opener-Policy': 'unsafe-none',
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
} as const;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; filename: string[] }> }
) {
  try {
    const { id, filename } = await params;
    const sessionId = await getSession();
    const storage = createSandboxedStorage(sessionId);

    const workspace = await storage.getWorkspace(id);
    if (!workspace) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    const filePath = filename.join('/');
    if (!filePath || filePath.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
      return NextResponse.json({ error: 'Invalid filename' }, { status: 400 });
    }

    const fileBuffer = await storage.readFileBuffer(id, filePath);
    if (!fileBuffer) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    const dotIndex = filePath.lastIndexOf('.');
    const ext = dotIndex > 0 ? filePath.slice(dotIndex).toLowerCase() : '';
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const safeFilename = filePath.split('/').pop()!.replace(/["\\\r\n]/g, '_');

    return new NextResponse(new Uint8Array(fileBuffer), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': fileBuffer.length.toString(),
        'Content-Disposition': `inline; filename="${safeFilename}"`,
        'Cache-Control': 'private, max-age=3600',
        ...(ext === '.html' ? HTML_PREVIEW_HEADERS : {}),
      },
    });
  } catch (error) {
    console.error('File serve error:', error);
    return NextResponse.json(
      { error: 'Failed to serve file' },
      { status: 500 }
    );
  }
}
