import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { createSandboxedStorage } from '@/lib/storage';
import { audit, getRequestMeta } from '@/lib/audit';

// Disable caching - workspace data changes frequently
export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const sessionId = await getSession();
  const storage = createSandboxedStorage(sessionId);

  const workspace = await storage.getWorkspace(id);
  if (!workspace) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  // Get tables
  const tables = await storage.listTables(id);

  // Get conversation
  const messages = await storage.getConversation(id);

  // Get UI state
  const uiState = await storage.getUIState(id);

  // Get charts from chart panels
  const chartIds = uiState.panels
    .filter(p => p.type === 'chart' && p.chartId)
    .map(p => p.chartId!);
  const charts = await Promise.all(
    chartIds.map((chartId) => storage.getChart(id, chartId))
  );
  const chartsMap: Record<string, unknown> = {};
  charts.filter(Boolean).forEach(chart => {
    if (chart) chartsMap[chart.id] = chart;
  });

  // Get cards from cards panels
  const cardsIds = uiState.panels
    .filter(p => p.type === 'cards' && p.cardsId)
    .map(p => p.cardsId!);
  const cardsData = await Promise.all(
    cardsIds.map((cardsId) => storage.getCards(id, cardsId))
  );
  const cardsMap: Record<string, unknown> = {};
  cardsData.filter(Boolean).forEach(cards => {
    if (cards) cardsMap[cards.id] = cards;
  });

  // Get pending downloads
  const downloads = await storage.getDownloads(id);

  return NextResponse.json({
    workspace,
    tables: tables.filter(Boolean),
    messages,
    uiState,
    charts: chartsMap,
    cards: cardsMap,
    downloads,
  });
}

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

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Whitelist allowed fields to prevent overwriting protected fields like id, createdAt
  const ALLOWED_FIELDS = ['name', 'description', 'systemPrompt', 'tools'] as const;
  const updates: Record<string, unknown> = {};

  for (const field of ALLOWED_FIELDS) {
    if (field in body) {
      const value = body[field];
      // Validate field types
      if (field === 'name' || field === 'description' || field === 'systemPrompt') {
        if (typeof value !== 'string') {
          return NextResponse.json({ error: `Field "${field}" must be a string` }, { status: 400 });
        }
        if (field === 'name' && (!value.trim() || value.length > 200)) {
          return NextResponse.json({ error: 'Name must be 1-200 characters' }, { status: 400 });
        }
        if (field === 'description' && value.length > 2000) {
          return NextResponse.json({ error: 'Description must be under 2000 characters' }, { status: 400 });
        }
      }
      if (field === 'tools') {
        if (!Array.isArray(value) || !value.every(t => typeof t === 'string')) {
          return NextResponse.json({ error: 'Tools must be an array of strings' }, { status: 400 });
        }
      }
      updates[field] = value;
    }
  }

  const updated = {
    ...workspace,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  await storage.setWorkspace(id, updated);

  return NextResponse.json({ workspace: updated });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const sessionId = await getSession();
  const storage = createSandboxedStorage(sessionId);

  await storage.deleteWorkspace(id);

  // Audit log workspace deletion
  const meta = getRequestMeta(request);
  audit('workspace.delete', {
    sessionId,
    workspaceId: id,
    ...meta,
  });

  return NextResponse.json({ success: true });
}
