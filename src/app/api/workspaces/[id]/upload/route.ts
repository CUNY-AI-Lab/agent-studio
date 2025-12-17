import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { createSandboxedStorage } from '@/lib/storage';
import { audit, getRequestMeta } from '@/lib/audit';

export const dynamic = 'force-dynamic';

// File upload limits
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB per file
const MAX_TOTAL_SIZE = 50 * 1024 * 1024; // 50MB total per upload
const MAX_FILES = 10;

// Allowed file types (MIME types and extensions)
const ALLOWED_TYPES = new Set([
  // Documents
  'application/pdf',
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
  // Spreadsheets
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  // Images
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  // Data
  'application/xml',
  'text/xml',
]);

const ALLOWED_EXTENSIONS = new Set([
  '.pdf', '.txt', '.csv', '.md', '.json',
  '.xlsx', '.xls',
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
  '.xml',
]);

function sanitizeFilename(filename: string): string {
  // Get extension
  const lastDot = filename.lastIndexOf('.');
  const ext = lastDot > 0 ? filename.slice(lastDot).toLowerCase() : '';
  const name = lastDot > 0 ? filename.slice(0, lastDot) : filename;

  // Sanitize name: only allow alphanumeric, dash, underscore
  const safeName = name
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 100); // Limit length

  return safeName + ext;
}

function isAllowedFile(file: File): { allowed: boolean; reason?: string } {
  // Check extension
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return { allowed: false, reason: `File extension '${ext}' not allowed` };
  }

  // Check MIME type (if provided)
  if (file.type && !ALLOWED_TYPES.has(file.type)) {
    // Allow if extension is valid but MIME is missing/generic
    if (file.type !== 'application/octet-stream' && file.type !== '') {
      return { allowed: false, reason: `File type '${file.type}' not allowed` };
    }
  }

  return { allowed: true };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const sessionId = await getSession();
    const storage = createSandboxedStorage(sessionId);

    const workspace = await storage.getWorkspace(id);
    if (!workspace) {
      return NextResponse.json(
        { error: 'Workspace not found' },
        { status: 404 }
      );
    }

    const formData = await request.formData();
    const files = formData.getAll('files') as File[];

    if (!files || files.length === 0) {
      return NextResponse.json(
        { error: 'No files provided' },
        { status: 400 }
      );
    }

    // Check file count
    if (files.length > MAX_FILES) {
      return NextResponse.json(
        { error: `Too many files. Maximum ${MAX_FILES} files allowed per upload.` },
        { status: 400 }
      );
    }

    // Validate all files first
    let totalSize = 0;
    for (const file of files) {
      // Check individual file size
      if (file.size > MAX_FILE_SIZE) {
        return NextResponse.json(
          { error: `File '${file.name}' exceeds maximum size of ${MAX_FILE_SIZE / 1024 / 1024}MB` },
          { status: 413 }
        );
      }

      totalSize += file.size;

      // Check file type
      const typeCheck = isAllowedFile(file);
      if (!typeCheck.allowed) {
        return NextResponse.json(
          { error: `File '${file.name}': ${typeCheck.reason}` },
          { status: 400 }
        );
      }
    }

    // Check total size
    if (totalSize > MAX_TOTAL_SIZE) {
      return NextResponse.json(
        { error: `Total upload size exceeds maximum of ${MAX_TOTAL_SIZE / 1024 / 1024}MB` },
        { status: 413 }
      );
    }

    const uploaded: { name: string; path: string; size: number }[] = [];

    for (const file of files) {
      const buffer = Buffer.from(await file.arrayBuffer());
      const safeName = sanitizeFilename(file.name);

      // Write file to storage (files are stored in the 'files' directory)
      await storage.writeFile(id, safeName, buffer);

      uploaded.push({
        name: safeName,
        path: `file:${safeName}`,
        size: file.size,
      });
    }

    // Audit log file upload
    const meta = getRequestMeta(request);
    audit('file.upload', {
      sessionId,
      workspaceId: id,
      details: {
        fileCount: uploaded.length,
        totalSize: totalSize,
        files: uploaded.map(f => f.name),
      },
      ...meta,
    });

    return NextResponse.json({
      success: true,
      files: uploaded,
    });
  } catch (error) {
    console.error('Upload error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 }
    );
  }
}
