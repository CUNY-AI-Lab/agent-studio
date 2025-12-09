import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ToolContext } from './types';

// Sandbox manager URL (can be configured via env)
const SANDBOX_URL = process.env.SANDBOX_URL || 'http://localhost:8765';

interface ExecuteResult {
  success: boolean;
  stdout: string;
  stderr: string;
  artifacts: { type: string; data: string }[];
}

/**
 * Execute Python code in a sandboxed environment.
 * Each workspace gets its own persistent sandbox session.
 */
export const createSandboxExecuteTool = (ctx: ToolContext) => {
  const { storage, workspaceId } = ctx;

  return tool(
    'execute_python',
    `Execute Python code in a secure sandbox environment.

The sandbox has these libraries pre-installed:
- pandas, numpy - Data manipulation
- matplotlib - Visualization
- pypdf, pdfplumber - PDF processing
- openpyxl - Excel files
- requests - HTTP calls

State persists between calls within this workspace.
You can define variables, import libraries, and they stay available.

Example:
\`\`\`python
import pandas as pd
df = pd.read_csv('data.csv')
print(df.head())
\`\`\`

To save results back to the workspace, print JSON that can be parsed.
To create visualizations, use matplotlib - images are captured automatically.`,
    z.object({
      code: z.string().describe('Python code to execute'),
      timeout: z.number().optional().describe('Execution timeout in seconds (default: 60)'),
    }).shape,
    async ({ code, timeout = 60 }) => {
      try {
        const response = await fetch(`${SANDBOX_URL}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspace_id: workspaceId,
            code,
            timeout,
          }),
        });

        if (!response.ok) {
          throw new Error(`Sandbox error: ${response.statusText}`);
        }

        const result: ExecuteResult = await response.json();

        // Build response content
        const content: { type: 'text' | 'image'; text?: string; data?: string; mimeType?: string }[] = [];

        // Add stdout/stderr
        if (result.stdout) {
          content.push({ type: 'text', text: result.stdout });
        }
        if (result.stderr) {
          content.push({ type: 'text', text: `stderr: ${result.stderr}` });
        }

        // Add any image artifacts
        for (const artifact of result.artifacts) {
          if (artifact.type === 'image') {
            content.push({
              type: 'image',
              data: artifact.data,
              mimeType: 'image/png',
            });
          }
        }

        if (content.length === 0) {
          content.push({ type: 'text', text: result.success ? 'Done (no output)' : 'Failed (no output)' });
        }

        return { content };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `Sandbox error: ${error instanceof Error ? error.message : String(error)}`,
          }],
        };
      }
    }
  );
};

/**
 * Check sandbox health
 */
export async function checkSandboxHealth(): Promise<{
  available: boolean;
  activeSessions: number;
}> {
  try {
    const response = await fetch(`${SANDBOX_URL}/health`);
    if (!response.ok) {
      return { available: false, activeSessions: 0 };
    }
    const data = await response.json();
    return {
      available: data.sandbox_available,
      activeSessions: data.active_sessions,
    };
  } catch {
    return { available: false, activeSessions: 0 };
  }
}
