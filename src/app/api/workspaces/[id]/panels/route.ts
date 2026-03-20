import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { createSandboxedStorage, UIPanel } from '@/lib/storage';

export const dynamic = 'force-dynamic';

const ALLOWED_PANEL_TYPES = new Set([
  'chat',
  'table',
  'editor',
  'preview',
  'fileTree',
  'detail',
  'chart',
  'cards',
  'markdown',
  'pdf',
]);

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
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    const body = await request.json();
    const panel = body?.panel as UIPanel | undefined;

    if (!panel || typeof panel !== 'object') {
      return NextResponse.json({ error: 'Panel required' }, { status: 400 });
    }
    if (!panel.id || typeof panel.id !== 'string' || panel.id.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(panel.id)) {
      return NextResponse.json({ error: 'Invalid panel id' }, { status: 400 });
    }
    if (!panel.type || !ALLOWED_PANEL_TYPES.has(panel.type)) {
      return NextResponse.json({ error: 'Invalid panel type' }, { status: 400 });
    }

    await storage.addPanel(id, panel);
    return NextResponse.json({ success: true, panel });
  } catch (error) {
    console.error('Failed to add panel:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to add panel' },
      { status: 500 }
    );
  }
}
