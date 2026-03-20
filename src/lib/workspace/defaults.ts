import type { WorkspaceConfig } from '../storage';

export const DEFAULT_WORKSPACE_TOOL_IDS = [
  'ui.table',
  'ui.chart',
  'ui.cards',
  'ui.markdown',
  'ui.pdf',
  'ui.showFile',
  'ui.workspace',
  'ui.addPanel',
  'ui.removePanel',
  'ui.updatePanel',
] as const;

const DEPRECATED_WORKSPACE_TOOL_IDS = new Set([
  'execute',
  'read',
  'write',
  'filter',
  'pick',
  'sort',
  'ui.message',
  'ui.setLayout',
]);

const LEGACY_SYSTEM_PROMPT_MARKERS = [
  'You have an `execute` tool that runs JavaScript code.',
  'Do everything in a SINGLE execute call when possible',
  'Combine API fetch + data transformation + setTable in one execute block',
  'const text = await read("file:data.csv");',
  'await setTable("results", {',
  'await setChart("trends", {',
  'await setWorkspaceInfo({',
];

function getPythonVenvPath(): string {
  return process.env.PYTHON_VENV_PATH || `${process.cwd()}/.venv`;
}

export function getDefaultWorkspaceSystemPrompt(): string {
  const pythonBin = `${getPythonVenvPath()}/bin/python3`;

  return `You are a Claude Code style agent working inside a tile-based infinite canvas workspace.

The workspace filesystem is the source of truth for durable outputs.
- If you create something the user may want to keep, write it as a real file in the workspace first.
- Tiles are views over workspace state. Files are the durable artifact.
- Never claim that a ZIP, PNG, PDF, HTML file, or other artifact exists unless you actually created the file.

## Primary Execution Surface

Use Claude Code built-in tools for coding and file work:
- Read, Write, Edit, Glob, Grep for workspace files
- Bash for commands, Python, package installs, git, and local artifact generation
- WebFetch and WebSearch for web research and external retrieval
- ReadMcpResource for app-provided canvas resources and local reference docs

The runtime will tell you the absolute workspace files directory and the MCP server name for this workspace.
Use that information directly when you need file paths or MCP resource reads.

For Python, the preferred interpreter is:
\`\`\`bash
${pythonBin}
\`\`\`

Available packages in the environment include:
pandas, numpy, scipy, scikit-learn, matplotlib, seaborn, pypdf, pdfplumber, openpyxl, xlsxwriter, pillow, python-docx, python-pptx

## Canvas Tools

Use the thin UI tools to project results onto the canvas:
- ui.table: create or update a table tile
- ui.chart: create or update a chart tile
- ui.cards: create or update a cards tile
- ui.markdown: create or update a markdown tile
- ui.pdf: show an existing PDF file as a tile
- ui.showFile: show an existing workspace file on the canvas
- ui.workspace: update the workspace title or description
- ui.addPanel / ui.updatePanel / ui.removePanel: lower-level tile controls when needed

These tools are for canvas/UI semantics only. Do not expect an execute-style JavaScript runtime.

## Reading App Context

Canvas-backed data is exposed as MCP resources on the current workspace server.
- Use ReadMcpResource to inspect a table, chart, cards tile, inline markdown tile, inline preview tile, file tree tile, or local app reference doc.
- File-backed tiles should usually be inspected through the real workspace file with Read/Edit/Bash.

Reference docs for supported APIs and workflows are also available as MCP resources:
- workspace://skills/index
- workspace://skills/<name>

There is no execute/read/write/filter/pick/sort tool in this workspace.

## Working Style

- Use the filesystem for real work and durable outputs.
- Use canvas tools to show results, previews, summaries, and visualizations.
- Prefer real files over inline downloads.
- If you create a file the user will likely inspect, consider surfacing it with ui.showFile or a more specific canvas tool.
- Keep the workspace title and description aligned with the task once you understand what the user is doing.`;
}

function isLegacyWorkspaceSystemPrompt(systemPrompt: string): boolean {
  return LEGACY_SYSTEM_PROMPT_MARKERS.some((marker) => systemPrompt.includes(marker));
}

function uniqueToolIds(toolIds: string[]): string[] {
  return Array.from(new Set(toolIds));
}

export function normalizeWorkspaceConfig(config: WorkspaceConfig): WorkspaceConfig {
  const normalizedSystemPrompt = !config.systemPrompt.trim() || isLegacyWorkspaceSystemPrompt(config.systemPrompt)
    ? getDefaultWorkspaceSystemPrompt()
    : config.systemPrompt;

  const preservedTools = config.tools.filter((toolId) => !DEPRECATED_WORKSPACE_TOOL_IDS.has(toolId));
  const normalizedTools = uniqueToolIds([
    ...DEFAULT_WORKSPACE_TOOL_IDS,
    ...preservedTools,
  ]);

  if (
    normalizedSystemPrompt === config.systemPrompt
    && normalizedTools.length === config.tools.length
    && normalizedTools.every((toolId, index) => toolId === config.tools[index])
  ) {
    return config;
  }

  return {
    ...config,
    systemPrompt: normalizedSystemPrompt,
    tools: normalizedTools,
  };
}

export function createDefaultWorkspaceConfig(args: {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}): WorkspaceConfig {
  return {
    ...args,
    systemPrompt: getDefaultWorkspaceSystemPrompt(),
    tools: [...DEFAULT_WORKSPACE_TOOL_IDS],
  };
}
