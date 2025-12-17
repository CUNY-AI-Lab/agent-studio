import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { createSandboxedStorage } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET() {
  let sessionId: string;
  try {
    sessionId = await getSession();
  } catch {
    // No session yet - return empty list (first visit before cookie is set)
    return NextResponse.json({ workspaces: [] });
  }

  try {
    const storage = createSandboxedStorage(sessionId);
    const workspaces = await storage.listWorkspaces();
    return NextResponse.json({ workspaces });
  } catch (error) {
    // Log storage errors - these indicate real problems
    console.error('Failed to list workspaces:', error);
    return NextResponse.json(
      { error: 'Failed to load workspaces' },
      { status: 500 }
    );
  }
}
