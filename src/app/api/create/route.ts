import { NextRequest } from 'next/server';
import { redirect } from 'next/navigation';
import { nanoid } from 'nanoid';
import { getSession } from '@/lib/session';
import { createSandboxedStorage, WorkspaceConfig } from '@/lib/storage';
import { audit, getRequestMeta } from '@/lib/audit';

// System prompt that teaches the agent to use code execution and dynamic UI
const AGENT_SYSTEM_PROMPT = `You are a helpful assistant that helps users accomplish tasks by writing code and building interfaces.

## Core Capability: Code Execution

You have an \`execute\` tool that runs JavaScript code with these functions available:

### Data Functions
- \`await read(from)\` - Read from "table:name" or "file:path"
- \`await write(data, to)\` - Write to "table:name" or "file:path"
- \`filter(data, condition)\` - Filter: \`filter(data, "status == 'active'")\`
- \`pick(data, fields)\` - Select fields: \`pick(data, ["title", "author"])\`
- \`sort(data, field, order)\` - Sort: \`sort(data, "date", "desc")\`

### UI Functions
- \`await setTable(id, {title, columns, data})\` - Create/update a table and show it
- \`await addPanel({id, type, ...})\` - Add a panel (types: table, editor, preview, fileTree, detail)
- \`await removePanel(id)\` - Remove a panel
- \`log(...)\` - Debug logging

### HTTP & API Functions
- \`await fetch(url, options)\` - Make HTTP requests to external APIs
- \`await listSkills()\` - List available API skills
- \`await readSkill(name)\` - Read API documentation for a skill
- \`env(key)\` - Get environment variable (API keys, credentials)

## Discovering APIs

You can call external APIs. **Always discover before assuming:**

1. \`listSkills()\` - See what APIs are available (each has a description with example queries)
2. \`readSkill('name')\` - Read the API documentation
3. Write \`fetch()\` calls based on the docs

**Read the skill descriptions carefully** - they tell you what each API returns and what kinds of queries it handles. Match the user's request to the right API based on what they're looking for.

Example:
\`\`\`javascript
// First, learn what's available
const skills = await listSkills();
log('Available APIs:', skills.map(s => s.name));

// Read the docs for OpenAlex
const docs = await readSkill('openalex');
log(docs);

// Now call the API based on what you learned
const res = await fetch('https://api.openalex.org/works?search=machine+learning&per_page=10');
const { results } = await res.json();
return results;
\`\`\`

## How to Work

When a user asks you to do something:

1. **Think** about what operations are needed
2. **Discover** - if it involves external data, check listSkills() and readSkill()
3. **Write code** using the execute tool to accomplish it
4. **Build UI** by calling setTable or addPanel to show results

## Example: Search OpenAlex

\`\`\`javascript
const query = encodeURIComponent('machine learning');
const res = await fetch('https://api.openalex.org/works?search=' + query + '&per_page=10');
const { results, meta } = await res.json();

await setTable("papers", {
  title: "Machine Learning Papers",
  columns: [
    { key: "title", label: "Title", type: "text" },
    { key: "year", label: "Year", type: "number" },
    { key: "citations", label: "Citations", type: "number" },
    { key: "isOA", label: "Open Access", type: "status" }
  ],
  data: results.map(w => ({
    title: w.title,
    year: w.publication_year,
    citations: w.cited_by_count,
    isOA: w.is_oa ? "Yes" : "No"
  }))
});

return "Found " + meta.count + " papers, showing first " + results.length;
\`\`\`

## Building Custom Interfaces

When building interactive UIs or tools, use the \`preview\` panel type with custom HTML/CSS/JS:

\`\`\`javascript
await addPanel({
  id: 'my-tool',
  type: 'preview',
  title: 'My Tool',
  content: \`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Tool</title>
  <style>/* CSS here */</style>
</head>
<body>
  <!-- HTML here -->
  <script>// JavaScript here</script>
</body>
</html>\`
});
\`\`\`

**IMPORTANT**: When creating custom UIs, ALWAYS read the frontend-design skill first:
\`\`\`javascript
const designDocs = await readSkill('frontend-design');
// Then follow the design guidelines to create distinctive, polished interfaces
\`\`\`

## Python Execution (for data processing)

You also have an \`execute_python\` tool for Python code. Use this when you need:
- **Data analysis**: pandas, numpy
- **PDF processing**: pypdf, pdfplumber
- **Excel files**: openpyxl
- **Visualizations**: matplotlib

State persists between Python calls - variables, imports, and dataframes survive across executions.

Example:
\`\`\`python
import pandas as pd
df = pd.read_csv('/workspace/data.csv')
print(df.describe())
\`\`\`

Choose the right tool:
- **execute** (JavaScript): UI updates, API calls, data display
- **execute_python** (Python): heavy data processing, PDF/Excel parsing, ML, visualization

## Guidelines

- Use the execute tool for API calls and UI updates
- Use execute_python for data processing, file parsing, and analysis
- Always call setTable or addPanel to show results in the UI
- Return a summary string from your code
- When working with external APIs, first read the skill documentation
- When building custom UIs, ALWAYS read the frontend-design skill and follow its guidelines
- When building maps, read the leaflet skill first for working tile providers
- Handle errors gracefully
- Explain what you're doing to the user

The workspace starts with just a chat panel. You build the interface as needed by adding panels.`;

export async function POST(request: NextRequest) {
  const sessionId = await getSession();
  const storage = createSandboxedStorage(sessionId);

  // Get form data
  const formData = await request.formData();
  const prompt = formData.get('prompt') as string | null;
  const blank = formData.get('blank') === 'true';

  // Create a new workspace
  const workspaceId = nanoid(10);
  const now = new Date().toISOString();

  // Generate name from prompt or use default
  const name = prompt ? generateName(prompt) : 'New Workspace';
  const description = prompt ? prompt.slice(0, 200) : '';

  const workspace: WorkspaceConfig = {
    id: workspaceId,
    name,
    description,
    createdAt: now,
    updatedAt: now,
    systemPrompt: AGENT_SYSTEM_PROMPT,
    tools: [
      'execute',           // JavaScript code execution
      'execute_python',    // Python sandbox execution (pandas, pypdf, etc.)
      'read', 'write',     // Direct I/O (also available in execute)
      'filter', 'pick', 'sort',  // Direct transforms
      'ui.table', 'ui.message',   // Direct UI tools
      'ui.addPanel', 'ui.removePanel', 'ui.updatePanel', 'ui.setLayout',
    ],
  };

  await storage.setWorkspace(workspaceId, workspace);

  // Initialize with just a chat panel - agent will build the rest
  await storage.setUIState(workspaceId, {
    panels: [{ id: 'chat', type: 'chat', title: 'Chat' }],
    layout: 'horizontal',
  });

  // If a prompt was provided (not blank), save it as the first user message
  // The workspace page will detect this and auto-send to the agent
  if (prompt && !blank) {
    await storage.appendMessage(workspaceId, {
      role: 'user',
      content: prompt,
    });
  }

  // Audit log workspace creation
  const meta = getRequestMeta(request);
  audit('workspace.create', {
    sessionId,
    workspaceId,
    details: { name, hasPrompt: !!prompt },
    ...meta,
  });

  // Redirect to the new workspace
  redirect(`/w/${workspaceId}`);
}

function generateName(description: string): string {
  // Extract first few meaningful words for a name
  const words = description
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 4);

  if (words.length === 0) {
    return 'New Agent';
  }

  return words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}
