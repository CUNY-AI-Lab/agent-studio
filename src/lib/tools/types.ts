import { SandboxedStorage } from '../storage';

export interface ToolContext {
  storage: SandboxedStorage;
  workspaceId: string;
}

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
};
