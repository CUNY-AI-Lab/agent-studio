import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { createSandboxedStorage } from '@/lib/storage';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; panelId: string }> }
) {
  try {
    const { id, panelId } = await params;
    const sessionId = await getSession();
    const storage = createSandboxedStorage(sessionId);

    const workspace = await storage.getWorkspace(id);
    if (!workspace) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    await storage.removePanel(id, panelId);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete panel:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete panel' },
      { status: 500 }
    );
  }
}
