import { NextResponse } from 'next/server';
import { getOrCreateSession } from '@/lib/session';
import { createSandboxedStorage } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const sessionId = await getOrCreateSession();
    const storage = createSandboxedStorage(sessionId);
    const workspaces = await storage.listWorkspaces();
    return NextResponse.json({ workspaces });
  } catch (error) {
    console.error('Failed to list workspaces:', error);
    return NextResponse.json(
      { error: 'Failed to load workspaces' },
      { status: 500 }
    );
  }
}
