import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { createSandboxedStorage } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const sessionId = await getSession();
  const storage = createSandboxedStorage(sessionId);

  const workspace = await storage.getWorkspace(id);
  if (!workspace) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  await storage.clearDownloads(id);

  return NextResponse.json({ success: true });
}
