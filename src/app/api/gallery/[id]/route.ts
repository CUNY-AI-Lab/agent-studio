import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { getGalleryItem, cloneGalleryItem, unpublishGalleryItem } from '@/lib/gallery';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const item = await getGalleryItem(id);

  if (!item) {
    return NextResponse.json({ error: 'Gallery item not found' }, { status: 404 });
  }

  return NextResponse.json({ item });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const sessionId = await getSession();

  try {
    const workspaceId = await cloneGalleryItem(id, sessionId);
    const url = new URL(`/w/${workspaceId}`, request.url);
    return NextResponse.redirect(url, 303);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to clone' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const sessionId = await getSession();

  try {
    await unpublishGalleryItem(id, sessionId);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to unpublish';
    const status = message.includes('Not authorized') ? 403 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
