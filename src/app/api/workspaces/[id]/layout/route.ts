import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { createSandboxedStorage } from '@/lib/storage';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const sessionId = await getSession();
  const storage = createSandboxedStorage(sessionId);

  const workspace = await storage.getWorkspace(id);
  if (!workspace) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  let updates: unknown;
  try {
    const body = await request.json();
    updates = body.updates;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Update each panel's layout
  if (Array.isArray(updates)) {
    for (const update of updates) {
      if (update.id && update.layout) {
        await storage.updatePanel(id, update.id, { layout: update.layout });
      }
    }
  }

  return NextResponse.json({ success: true });
}
