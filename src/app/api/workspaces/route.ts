import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { createSandboxedStorage } from '@/lib/storage';

export async function GET() {
  try {
    const sessionId = await getSession();
    const storage = createSandboxedStorage(sessionId);
    const workspaces = await storage.listWorkspaces();

    return NextResponse.json({ workspaces });
  } catch {
    // No session yet - return empty list
    return NextResponse.json({ workspaces: [] });
  }
}
