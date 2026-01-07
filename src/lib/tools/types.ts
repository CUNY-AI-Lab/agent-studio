import type { SandboxedStorage, UIPanel, Table, ChartData, CardsData } from '../storage';

export interface PanelUpdate {
  action: 'add' | 'update' | 'remove';
  panel: UIPanel;
  data?: {
    table?: Table;
    chart?: ChartData;
    cards?: CardsData;
    content?: string;
  };
}

export interface ToolContext {
  storage: SandboxedStorage;
  workspaceId: string;
  emitPanelUpdates?: (updates: PanelUpdate[]) => void;
}

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
};
