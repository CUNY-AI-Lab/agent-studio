import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { createSandboxedStorage } from '@/lib/storage';
import { audit, getRequestMeta } from '@/lib/audit';
import { sanitizeFilename, isAllowedFile } from '@/lib/upload/validation';

export const dynamic = 'force-dynamic';

// File upload limits
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB per file
const MAX_TOTAL_SIZE = 50 * 1024 * 1024; // 50MB total per upload
const MAX_FILES = 10;

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
