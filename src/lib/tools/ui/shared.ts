import type { PanelLayout, UIPanel } from '../../storage';
import type { ToolContext, PanelUpdate } from '../types';

export interface DefaultPanelSize {
  width: number;
  height: number;
}

export function emitPanelUpdate(ctx: ToolContext, update: PanelUpdate): void {
  ctx.emitPanelUpdates?.([update]);
}

export async function refreshWorkspaceResources(ctx: ToolContext): Promise<void> {
  await ctx.refreshMcpResources?.();
}

export function resolvePanelLayout(
  existingPanel: UIPanel | undefined,
  requestedLayout: Partial<PanelLayout> | undefined,
  defaultSize: DefaultPanelSize
): PanelLayout | undefined {
  if (!existingPanel) {
    return requestedLayout ? { ...defaultSize, ...requestedLayout } : undefined;
  }

  const hasExistingPosition = existingPanel.layout?.x !== undefined && existingPanel.layout?.y !== undefined;
  if (hasExistingPosition) {
    return {
      x: requestedLayout?.x ?? existingPanel.layout?.x ?? 0,
      y: requestedLayout?.y ?? existingPanel.layout?.y ?? 0,
      width: requestedLayout?.width ?? existingPanel.layout?.width ?? defaultSize.width,
      height: requestedLayout?.height ?? existingPanel.layout?.height ?? defaultSize.height,
      rotation: requestedLayout?.rotation ?? existingPanel.layout?.rotation,
      groupId: requestedLayout?.groupId ?? existingPanel.layout?.groupId,
    };
  }

  if (requestedLayout) {
    return { ...defaultSize, ...requestedLayout };
  }

  return existingPanel.layout;
}

function hashString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash) + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

export function makeFileTilePanelId(filePath: string): string {
  return `file_${hashString(filePath)}`;
}

export function getFileTilePanelType(filePath: string): 'editor' | 'pdf' {
  return filePath.toLowerCase().endsWith('.pdf') ? 'pdf' : 'editor';
}
