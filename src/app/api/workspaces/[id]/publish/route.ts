import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { publishWorkspace } from '@/lib/gallery';
import { createSandboxedStorage } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const sessionId = await getSession();

  let title: string | undefined;
  let description: string | undefined;
  try {
    const body = await request.json();
    title = body.title;
    description = body.description;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!title || !description) {
    return NextResponse.json(
      { error: 'Title and description are required' },
      { status: 400 }
    );
  }

  try {
    const galleryItem = await publishWorkspace(sessionId, id, title, description);

    // Store galleryId on workspace
    const storage = createSandboxedStorage(sessionId);
    const workspace = await storage.getWorkspace(id);
    if (workspace) {
      workspace.galleryId = galleryItem.id;
      await storage.setWorkspace(id, workspace);
    }

    return NextResponse.json({ item: galleryItem });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to publish' },
      { status: 500 }
    );
  }
}
