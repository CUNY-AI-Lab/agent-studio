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

  let viewport: { x: number; y: number; zoom: number };
  try {
    viewport = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Update viewport in UI state
  const uiState = await storage.getUIState(id);
  uiState.viewport = viewport;
  await storage.setUIState(id, uiState);

  return NextResponse.json({ success: true });
}
