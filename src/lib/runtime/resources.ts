import { readFile } from 'fs/promises';
import path from 'path';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { SandboxedStorage, UIPanel } from '../storage';

type WorkspaceMcpServer = ReturnType<typeof createSdkMcpServer>['instance'];

interface ResourceHandle {
  remove: () => void;
  update: (next: {
    uri?: string | null;
    name?: string | null;
    metadata?: Record<string, unknown>;
    callback?: (uri: URL) => Promise<{ contents: Array<{ uri: string; mimeType?: string; text?: string }> }>;
    enabled?: boolean;
  }) => void;
}

interface WorkspaceResourceSpec {
  uri: string;
  name: string;
  metadata: {
    description: string;
    mimeType: string;
  };
  callback: (uri: URL) => Promise<{ contents: Array<{ uri: string; mimeType?: string; text?: string }> }>;
}

const SKILLS_DIR = path.join(process.cwd(), 'src/lib/skills');
const SKILLS_INDEX_PATH = path.join(SKILLS_DIR, 'index.json');

function makeWorkspaceUri(category: string, id: string): string {
  return `workspace://${category}/${encodeURIComponent(id)}`;
}

function makeSkillResourceUri(name: string): string {
  return `workspace://skills/${encodeURIComponent(name)}`;
}

function makePanelResourceUri(panel: UIPanel): string | null {
  if (panel.type === 'table' && panel.tableId) return makeWorkspaceUri('table', panel.tableId);
  if (panel.type === 'chart' && panel.chartId) return makeWorkspaceUri('chart', panel.chartId);
  if (panel.type === 'cards' && panel.cardsId) return makeWorkspaceUri('cards', panel.cardsId);
  if (panel.type === 'markdown' && panel.content) return makeWorkspaceUri('panel-markdown', panel.id);
  if (panel.type === 'preview' && panel.content) return makeWorkspaceUri('panel-preview', panel.id);
  if (panel.type === 'fileTree') return makeWorkspaceUri('panel-files', panel.id);
  return null;
}

function buildTextResource(args: {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  readText: () => Promise<string>;
}): WorkspaceResourceSpec {
  return {
    uri: args.uri,
    name: args.name,
    metadata: {
      description: args.description,
      mimeType: args.mimeType,
    },
    callback: async (requestedUri) => ({
      contents: [
        {
          uri: requestedUri.toString(),
          mimeType: args.mimeType,
          text: await args.readText(),
        },
      ],
    }),
  };
}

async function readSkillsIndex(): Promise<Array<{ name: string; description: string }>> {
  try {
    return JSON.parse(await readFile(SKILLS_INDEX_PATH, 'utf-8')) as Array<{ name: string; description: string }>;
  } catch {
    return [];
  }
}

function withWorkspaceToolingNote(markdown: string): string {
  return [
    '> Workspace note: use Claude Code built-ins for files, Bash, and web access in this app.',
    '> Use the thin UI tools `ui.table`, `ui.chart`, `ui.cards`, `ui.markdown`, `ui.pdf`, `ui.showFile`, and `ui.workspace` for tile and workspace updates.',
    '> If examples mention legacy helpers such as `execute`, `setTable`, `setChart`, `setPdf`, `setWorkspaceInfo`, `read`, `write`, `filter`, `pick`, or `sort`, translate them to the current tool surface.',
    '',
    markdown,
  ].join('\n');
}

async function buildWorkspaceResourceSpecs(
  storage: SandboxedStorage,
  workspaceId: string
): Promise<WorkspaceResourceSpec[]> {
  const [tables, charts, cards, uiState, skillsIndex] = await Promise.all([
    storage.listTables(workspaceId),
    storage.listCharts(workspaceId),
    storage.listCards(workspaceId),
    storage.getUIState(workspaceId),
    readSkillsIndex(),
  ]);

  const resources: WorkspaceResourceSpec[] = [];

  resources.push(
    buildTextResource({
      uri: 'workspace://skills/index',
      name: 'skills-index',
      description: 'Index of local API and workflow reference docs available to the agent.',
      mimeType: 'application/json',
      readText: async () => JSON.stringify(skillsIndex, null, 2),
    })
  );

  for (const skill of skillsIndex) {
    resources.push(
      buildTextResource({
        uri: makeSkillResourceUri(skill.name),
        name: `skill-${skill.name}`,
        description: `Local reference doc for ${skill.name}.`,
        mimeType: 'text/markdown',
        readText: async () => {
          const skillPath = path.join(SKILLS_DIR, `${skill.name}.md`);
          try {
            return withWorkspaceToolingNote(await readFile(skillPath, 'utf-8'));
          } catch {
            return withWorkspaceToolingNote(`# ${skill.name}\n\n${skill.description}`);
          }
        },
      })
    );
  }

  for (const table of tables) {
    resources.push(
      buildTextResource({
        uri: makeWorkspaceUri('table', table.id),
        name: `table-${table.id}`,
        description: `Canvas table data for ${table.title}.`,
        mimeType: 'application/json',
        readText: async () => JSON.stringify(await storage.getTable(workspaceId, table.id), null, 2),
      })
    );
  }

  for (const chart of charts) {
    resources.push(
      buildTextResource({
        uri: makeWorkspaceUri('chart', chart.id),
        name: `chart-${chart.id}`,
        description: `Canvas chart data for ${chart.title}.`,
        mimeType: 'application/json',
        readText: async () => JSON.stringify(await storage.getChart(workspaceId, chart.id), null, 2),
      })
    );
  }

  for (const cardsSet of cards) {
    resources.push(
      buildTextResource({
        uri: makeWorkspaceUri('cards', cardsSet.id),
        name: `cards-${cardsSet.id}`,
        description: `Canvas cards data for ${cardsSet.title}.`,
        mimeType: 'application/json',
        readText: async () => JSON.stringify(await storage.getCards(workspaceId, cardsSet.id), null, 2),
      })
    );
  }

  for (const panel of uiState.panels) {
    const uri = makePanelResourceUri(panel);
    if (!uri) continue;

    if (panel.type === 'markdown') {
      resources.push(
        buildTextResource({
          uri,
          name: `panel-markdown-${panel.id}`,
          description: `Inline markdown content for tile ${panel.title || panel.id}.`,
          mimeType: 'text/markdown',
          readText: async () => {
            const nextUiState = await storage.getUIState(workspaceId);
            const nextPanel = nextUiState.panels.find((entry) => entry.id === panel.id && entry.type === 'markdown');
            return nextPanel?.content || '';
          },
        })
      );
      continue;
    }

    if (panel.type === 'preview') {
      resources.push(
        buildTextResource({
          uri,
          name: `panel-preview-${panel.id}`,
          description: `Inline preview HTML for tile ${panel.title || panel.id}.`,
          mimeType: 'text/html',
          readText: async () => {
            const nextUiState = await storage.getUIState(workspaceId);
            const nextPanel = nextUiState.panels.find((entry) => entry.id === panel.id && entry.type === 'preview');
            return nextPanel?.content || '';
          },
        })
      );
      continue;
    }

    if (panel.type === 'fileTree') {
      resources.push(
        buildTextResource({
          uri,
          name: `panel-files-${panel.id}`,
          description: 'Workspace file tree as JSON.',
          mimeType: 'application/json',
          readText: async () => JSON.stringify(await storage.listFiles(workspaceId, ''), null, 2),
        })
      );
    }
  }

  return resources;
}

export function createWorkspaceResourceRegistrar(args: {
  server: WorkspaceMcpServer;
  storage: SandboxedStorage;
  workspaceId: string;
}) {
  const { server, storage, workspaceId } = args;
  const registered = new Map<string, ResourceHandle>();

  return {
    async sync(): Promise<void> {
      const nextResources = await buildWorkspaceResourceSpecs(storage, workspaceId);
      const nextUris = new Set(nextResources.map((resource) => resource.uri));

      for (const [uri, handle] of registered.entries()) {
        if (nextUris.has(uri)) continue;
        handle.remove();
        registered.delete(uri);
      }

      for (const resource of nextResources) {
        const existing = registered.get(resource.uri);
        if (existing) {
          existing.update({
            name: resource.name,
            metadata: resource.metadata,
            callback: resource.callback,
            enabled: true,
          });
          continue;
        }

        const handle = server.resource(
          resource.name,
          resource.uri,
          resource.metadata,
          resource.callback
        ) as ResourceHandle;
        registered.set(resource.uri, handle);
      }
    },
  };
}
