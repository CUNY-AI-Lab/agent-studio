import { NextResponse } from 'next/server';
import { listGalleryItems } from '@/lib/gallery';

export const dynamic = 'force-dynamic';

export async function GET() {
  const items = await listGalleryItems();
  return NextResponse.json({ items });
}
