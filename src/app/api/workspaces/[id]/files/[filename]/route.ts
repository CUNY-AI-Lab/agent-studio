import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { createSandboxedStorage } from '@/lib/storage';

// MIME types for common file extensions
const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.xml': 'application/xml',
};

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; filename: string }> }
) {
  try {
    const { id, filename } = await params;
    const sessionId = await getSession();
    const storage = createSandboxedStorage(sessionId);

    // Check workspace exists
    const workspace = await storage.getWorkspace(id);
    if (!workspace) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    // Validate filename (basic sanitation - storage layer handles path traversal)
    if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return NextResponse.json({ error: 'Invalid filename' }, { status: 400 });
    }

    // Read file from storage (use readFileBuffer for binary files)
    const fileBuffer = await storage.readFileBuffer(id, filename);
    if (!fileBuffer) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    // Determine content type
    const dotIndex = filename.lastIndexOf('.');
    const ext = dotIndex > 0 ? filename.slice(dotIndex).toLowerCase() : '';
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // Sanitize filename for Content-Disposition header (RFC 5987)
    const safeFilename = filename.replace(/["\\\r\n]/g, '_');

    // Return file with appropriate headers
    // Convert Buffer to Uint8Array for NextResponse compatibility
    return new NextResponse(new Uint8Array(fileBuffer), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': fileBuffer.length.toString(),
        'Content-Disposition': `inline; filename="${safeFilename}"`,
        // Cache for 1 hour (files don't change often)
        'Cache-Control': 'private, max-age=3600',
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
