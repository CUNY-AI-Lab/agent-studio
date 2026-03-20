import { CardsData, ChartData, Message, SandboxedStorage, Table, UIPanel, WorkspaceConfig } from '../storage';

// Panel updates streamed from thin canvas UI tools
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

export interface QueryOptions {
  abortController?: AbortController;
  includeWorkspaceState?: boolean;
}

export interface WorkspaceRuntime {
  config: WorkspaceConfig;
  storage: SandboxedStorage;

  query(prompt: string, conversationHistory?: Message[], options?: QueryOptions): AsyncIterable<StreamEvent>;
}

export type SdkEvent = { type: string; [key: string]: unknown };

export type StreamEvent =
  | SdkEvent
  | {
      type: 'panel_update';
      panelUpdates: PanelUpdate[];
    }
  | {
      type: 'error';
      error: string;
    };
