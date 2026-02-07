import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { getActiveQuery, removeActiveQuery } from '../route';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const sessionId = await getSession();
  const queryKey = `${sessionId}:${id}`;

  const abortController = getActiveQuery(queryKey);
  if (abortController) {
    abortController.abort();
    removeActiveQuery(queryKey);
    return NextResponse.json({ success: true, message: 'Query aborted' });
  }

  return NextResponse.json({ success: false, message: 'No active query found' });
}
