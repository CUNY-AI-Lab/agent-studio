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

  let body: { panels?: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Update panel layouts: { panels: { panelId: { x, y, width, height }, ... } }
  if (body.panels && typeof body.panels === 'object') {
    for (const [panelId, layout] of Object.entries(body.panels)) {
      // Validate panelId format
      if (!/^[a-zA-Z0-9_-]+$/.test(panelId) || panelId.length > 64) {
        continue; // Skip invalid panel IDs
      }

      if (layout && typeof layout === 'object' && 'x' in layout && 'y' in layout) {
        const layoutObj = layout as Record<string, unknown>;

        // Validate numeric values
        const x = Number(layoutObj.x);
        const y = Number(layoutObj.y);
        const width = Number(layoutObj.width);
        const height = Number(layoutObj.height);

        // Ensure values are finite numbers within reasonable bounds
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          continue; // Skip invalid layouts
        }

        const validatedLayout: { x: number; y: number; width?: number; height?: number } = {
          x: Math.max(0, Math.min(x, 100000)), // Clamp to canvas bounds
          y: Math.max(0, Math.min(y, 100000)),
        };

        // Width and height are optional but must be valid if provided
        if (Number.isFinite(width) && width > 0) {
          validatedLayout.width = Math.max(100, Math.min(width, 10000));
        }
        if (Number.isFinite(height) && height > 0) {
          validatedLayout.height = Math.max(50, Math.min(height, 10000));
        }

        await storage.updatePanel(id, panelId, { layout: validatedLayout as { x: number; y: number; width: number; height: number } });
      }
    }
  }

  return NextResponse.json({ success: true });
}
