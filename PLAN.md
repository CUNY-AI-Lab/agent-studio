# Agent Studio

A platform for the CUNY community where people describe what they need and get a working agent app.

---

## Vision

Someone at CUNY says: "I need to search faculty publications and build acquisition lists."

They get an agent that does exactly that. They use it. They say "it's not checking for ebook availability." It fixes itself. No code. No deploy. Just describe, use, improve.

---

## Core Principles

### 1. Unix Philosophy

Small tools that do one thing well. Composable. Pipeable.

```typescript
// Not this (monolithic):
await createTableWithWorldcatData({ query: '...', columns: [...] });

// This (composable):
const results = await search({ source: 'worldcat', query: '...' });
const filtered = await filter({ data: results, where: 'year > 2020' });
const selected = await pick({ data: filtered, fields: ['title', 'author', 'isbn'] });
await write({ data: selected, to: 'table:acquisitions' });
```

The agent thinks in code, composing primitives.

### 2. Agent Writes Code

Following Anthropic's guidance: agents that execute code are more powerful than agents that just call tools. The meta-agent generates agents that write and execute code using the tool primitives.

### 3. Per-User Sandboxing

Like Site Studio: each user gets isolated storage. Cookie-based sessions. No user can see another's workspaces or data.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Agent Studio                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │  Meta-Agent  │    │  Workspaces  │    │   Sessions   │      │
│  │              │    │              │    │   (cookies)  │      │
│  └──────┬───────┘    └──────┬───────┘    └──────────────┘      │
│         │                   │                                    │
│  ┌──────▼───────────────────▼────────────────────────────┐     │
│  │                      Runtime                           │     │
│  │                                                        │     │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐   │     │
│  │  │ Claude SDK  │  │    Tools    │  │  Sandboxed  │   │     │
│  │  │             │  │   (unix)    │  │   Storage   │   │     │
│  │  │ query()     │  │             │  │             │   │     │
│  │  │ streaming   │  │ read/write  │  │ /users/{id} │   │     │
│  │  │ code exec   │  │ filter/map  │  │   ├─ tables │   │     │
│  │  └─────────────┘  │ search/fetch│  │   ├─ files  │   │     │
│  │                   └─────────────┘  │   └─ state  │   │     │
│  │                                    └─────────────┘   │     │
│  └───────────────────────────────────────────────────────┘     │
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐      │
│  │                        UI                             │      │
│  │  shadcn/ui  │  AI Elements  │  Workspace Layouts     │      │
│  └──────────────────────────────────────────────────────┘      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Stack

| Layer | Technology |
|-------|------------|
| Framework | Next.js 15 (App Router) |
| UI Primitives | shadcn/ui + Tailwind v4 |
| AI Components | AI Elements (Vercel) |
| Agent Runtime | @anthropic-ai/claude-agent-sdk |
| Database | SQLite (Drizzle) |
| Sessions | Cookie-based (iron-session or similar) |
| Storage | Filesystem, sandboxed per user |
| Deployment | CUNY server (Node) |

---

## Tool Library (Unix-Style)

### Core Primitives

```
src/lib/tools/
├── io/
│   ├── read.ts          # Read from source (table, file, url)
│   ├── write.ts         # Write to destination
│   ├── append.ts        # Append to existing
│   └── delete.ts        # Remove data
├── transform/
│   ├── filter.ts        # Filter by condition
│   ├── map.ts           # Transform each item
│   ├── pick.ts          # Select fields
│   ├── sort.ts          # Order by field
│   ├── group.ts         # Group by field
│   ├── unique.ts        # Deduplicate
│   └── flatten.ts       # Flatten nested
├── search/
│   ├── worldcat.ts      # Search WorldCat
│   ├── openalex.ts      # Search OpenAlex
│   ├── web.ts           # Web search
│   └── fetch.ts         # Fetch URL
├── format/
│   ├── csv.ts           # To/from CSV
│   ├── json.ts          # To/from JSON
│   └── markdown.ts      # To/from Markdown
└── ui/
    ├── table.ts         # Create/update table view
    ├── message.ts       # Show message
    ├── confirm.ts       # Request confirmation
    └── progress.ts      # Show progress
```

### Tool Signatures

Each tool follows a consistent pattern:

```typescript
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

// read: Read data from a source
export const read = tool(
  'read',
  'Read data from a source (table, file, or URL)',
  z.object({
    from: z.string().describe('Source: "table:name", "file:path", or URL'),
    where: z.string().optional().describe('Filter condition'),
    limit: z.number().optional().describe('Max items to return')
  }).shape,
  async ({ from, where, limit }, ctx) => {
    // Implementation reads from sandboxed storage
  }
);

// filter: Filter data by condition
export const filter = tool(
  'filter',
  'Filter array of items by condition',
  z.object({
    data: z.array(z.any()).describe('Input data'),
    where: z.string().describe('Condition: "field == value", "field > n", etc.')
  }).shape,
  async ({ data, where }) => {
    // Pure transformation, no side effects
  }
);

// write: Write data to destination
export const write = tool(
  'write',
  'Write data to destination (table, file)',
  z.object({
    data: z.any().describe('Data to write'),
    to: z.string().describe('Destination: "table:name" or "file:path"'),
    mode: z.enum(['replace', 'append']).default('replace')
  }).shape,
  async ({ data, to, mode }, ctx) => {
    // Implementation writes to sandboxed storage
  }
);
```

### Composition Example

Agent writes code that chains tools:

```typescript
// Agent-generated code to build an acquisition list:

// 1. Search for publications
const pubs = await search({
  source: 'openalex',
  query: 'author:chen machine learning',
  limit: 50
});

// 2. Filter recent ones
const recent = await filter({
  data: pubs,
  where: 'year >= 2023'
});

// 3. Enrich with WorldCat data
const enriched = await map({
  data: recent,
  transform: async (pub) => {
    const wc = await search({ source: 'worldcat', query: pub.doi });
    return { ...pub, holdings: wc[0]?.holdings, isbn: wc[0]?.isbn };
  }
});

// 4. Select fields for table
const rows = await pick({
  data: enriched,
  fields: ['title', 'author', 'year', 'isbn', 'holdings']
});

// 5. Write to table
await write({
  data: rows,
  to: 'table:acquisitions'
});

// 6. Update UI
await table({
  id: 'acquisitions',
  title: 'Faculty Publications - Acquisition List',
  data: rows
});
```

---

## Sandboxed Storage

Like Site Studio: each user gets their own directory.

```
data/
└── users/
    ├── {session-id-1}/
    │   ├── workspaces/
    │   │   ├── {workspace-id}/
    │   │   │   ├── config.json      # Workspace configuration
    │   │   │   ├── tables/
    │   │   │   │   └── acquisitions.json
    │   │   │   ├── files/
    │   │   │   │   └── ...
    │   │   │   └── conversations/
    │   │   │       └── current.json
    │   │   └── ...
    │   └── session.json             # User session data
    └── {session-id-2}/
        └── ...
```

### Storage Interface

```typescript
interface SandboxedStorage {
  userId: string;
  basePath: string;  // data/users/{userId}

  // Tables
  getTable(workspaceId: string, tableId: string): Promise<Table>;
  setTable(workspaceId: string, tableId: string, data: Table): Promise<void>;

  // Files
  readFile(workspaceId: string, path: string): Promise<string>;
  writeFile(workspaceId: string, path: string, content: string): Promise<void>;
  listFiles(workspaceId: string, dir?: string): Promise<FileInfo[]>;

  // Workspace config
  getWorkspace(workspaceId: string): Promise<WorkspaceConfig>;
  setWorkspace(workspaceId: string, config: WorkspaceConfig): Promise<void>;
  listWorkspaces(): Promise<WorkspaceConfig[]>;
}
```

### Storage Factory

```typescript
// Tools get storage via context
async function handleQuery(userId: string, workspaceId: string, prompt: string) {
  const storage = createSandboxedStorage(userId);

  const tools = createTools({
    storage,
    workspaceId,
    // Tools can only access this user's data
  });

  // ...
}
```

---

## Session Management

Simple cookie-based sessions. No auth to start - just generate a session ID.

```typescript
// middleware.ts
import { cookies } from 'next/headers';
import { nanoid } from 'nanoid';

export async function getOrCreateSession() {
  const cookieStore = cookies();
  let sessionId = cookieStore.get('agent-studio-session')?.value;

  if (!sessionId) {
    sessionId = nanoid();
    cookieStore.set('agent-studio-session', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 365  // 1 year
    });

    // Create user directory
    await fs.mkdir(`data/users/${sessionId}/workspaces`, { recursive: true });
  }

  return sessionId;
}
```

---

## Workspace Configuration

```typescript
interface WorkspaceConfig {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;

  // Agent config
  systemPrompt: string;
  tools: string[];              // Tool IDs to include

  // UI config
  layout: 'chat' | 'chat-table' | 'chat-files' | 'chat-preview';

  // Optional initial state
  tables?: Record<string, TableSchema>;
}
```

### Example Workspace

```json
{
  "id": "acq-tracker",
  "name": "Acquisition Tracker",
  "description": "Track faculty publications for library acquisition",
  "createdAt": "2025-01-15T...",
  "updatedAt": "2025-01-15T...",
  "systemPrompt": "You are a library acquisition assistant...\n\n## Available Operations\n\nYou can compose these tools...",
  "tools": ["read", "write", "filter", "map", "pick", "search.openalex", "search.worldcat", "ui.table"],
  "layout": "chat-table",
  "tables": {
    "acquisitions": {
      "columns": [
        { "key": "title", "label": "Title", "type": "text" },
        { "key": "author", "label": "Author", "type": "text" },
        { "key": "year", "label": "Year", "type": "number" },
        { "key": "isbn", "label": "ISBN", "type": "text" },
        { "key": "status", "label": "Status", "type": "status" }
      ]
    }
  }
}
```

---

## Routes

```
app/
├── page.tsx                        # Landing: "What do you need?"
├── layout.tsx                      # Session middleware
├── w/
│   └── [id]/
│       ├── page.tsx                # Workspace view
│       └── api/
│           ├── query/route.ts      # POST: stream agent response
│           ├── tables/route.ts     # Table operations
│           └── files/route.ts      # File operations
├── dashboard/
│   └── page.tsx                    # List workspaces
└── api/
    ├── workspaces/
    │   └── route.ts                # Create workspace
    └── create/
        └── route.ts                # Meta-agent: create from description
```

---

## UI Components

### Layouts

```tsx
// WorkspaceShell wraps everything
<WorkspaceShell workspace={config}>
  {layout === 'chat' && <ChatLayout />}
  {layout === 'chat-table' && <ChatTableLayout />}
  {layout === 'chat-files' && <ChatFilesLayout />}
</WorkspaceShell>
```

### Chat (AI Elements)

```tsx
import { Conversation, Message } from '@/components/ai';

function ChatPanel({ workspace }) {
  const { messages, sendMessage, isStreaming } = useWorkspaceChat(workspace.id);

  return (
    <Conversation>
      {messages.map(m => (
        <Message key={m.id} role={m.role} content={m.content} />
      ))}
      <ChatInput onSend={sendMessage} disabled={isStreaming} />
    </Conversation>
  );
}
```

### Table (shadcn DataTable)

```tsx
import { DataTable } from '@/components/ui/data-table';

function TablePanel({ workspace, tableId }) {
  const { table, updateCell } = useWorkspaceTable(workspace.id, tableId);

  return (
    <DataTable
      columns={table.columns}
      data={table.data}
      onCellEdit={updateCell}
    />
  );
}
```

---

## Meta-Agent

Creates new workspaces from natural language descriptions.

### System Prompt (abbreviated)

```markdown
You are the Agent Studio meta-agent. You create AI agent workspaces.

When a user describes what they need:
1. Understand their workflow
2. Design an agent to help
3. Select tools (composable unix-style primitives)
4. Write a system prompt teaching the agent to compose tools
5. Configure the UI layout
6. Output the workspace configuration

## Tool Primitives

### I/O
- read: Read from source (table, file, URL)
- write: Write to destination
- append: Append to existing
- delete: Remove data

### Transform
- filter: Filter by condition
- map: Transform each item
- pick: Select fields
- sort: Order by field
- group: Group by field
- unique: Deduplicate

### Search
- search.worldcat: Search WorldCat
- search.openalex: Search OpenAlex
- search.web: Web search
- fetch: Fetch URL content

### Format
- format.csv: Parse/generate CSV
- format.json: Parse/generate JSON
- format.markdown: Parse/generate Markdown

### UI
- ui.table: Create/update table view
- ui.message: Show message to user
- ui.confirm: Request confirmation
- ui.progress: Show progress

## Composition

Agents compose tools by writing code:

const data = await read({ from: 'table:sources' });
const filtered = await filter({ data, where: 'status == "pending"' });
await write({ data: filtered, to: 'file:pending.csv' });

## Output Format

Output a JSON workspace configuration:

{
  "name": "...",
  "description": "...",
  "systemPrompt": "...",
  "tools": [...],
  "layout": "chat-table"
}

Write detailed system prompts (50+ lines) that teach the agent how to compose the tools for the specific workflow.
```

---

## Implementation Phases

### Phase 1: Foundation

- [ ] Next.js project with shadcn/ui + AI Elements
- [ ] Cookie-based session management
- [ ] Sandboxed storage (filesystem per user)
- [ ] Core tool primitives (read, write, filter, map, pick)
- [ ] WorkspaceRuntime with code execution
- [ ] Chat UI with streaming
- [ ] One layout: chat-table

**Deliverable:** Hardcode a workspace, use it, verify tools work

### Phase 2: Table Workflow

- [ ] Full table tools (ui.table, sort, group, unique)
- [ ] Table UI component with editing
- [ ] Export (CSV, JSON)
- [ ] Persistence

**Deliverable:** An agent that builds and manipulates tables

### Phase 3: Search Integration

- [ ] WorldCat search tool
- [ ] OpenAlex search tool
- [ ] Web search + fetch tools
- [ ] Compose search → transform → table

**Deliverable:** Research-capable agents

### Phase 4: Meta-Agent

- [ ] Meta-agent system prompt
- [ ] Workspace creation flow
- [ ] "What do you need?" UI
- [ ] Tool registry for meta-agent

**Deliverable:** Describe → get working agent

### Phase 5: Self-Improvement

- [ ] Workspace update tools
- [ ] Prompt refinement flow
- [ ] Version history

**Deliverable:** "This isn't working" → agent fixes itself

### Phase 6: Files

- [ ] File storage in sandbox
- [ ] File tools (read, write, edit, list)
- [ ] File browser UI
- [ ] Preview pane
- [ ] chat-files layout

**Deliverable:** File-based agents (like Site Studio)

### Phase 7: Polish

- [ ] Templates (pre-built workspaces)
- [ ] Clone/share workspaces
- [ ] Better error handling
- [ ] Usage documentation

---

## Directory Structure

```
agent-studio/
├── src/
│   ├── app/
│   │   ├── page.tsx
│   │   ├── layout.tsx
│   │   ├── w/[id]/page.tsx
│   │   ├── dashboard/page.tsx
│   │   └── api/
│   ├── components/
│   │   ├── ui/                    # shadcn
│   │   ├── ai/                    # AI Elements
│   │   └── workspace/             # Layouts, panels
│   ├── lib/
│   │   ├── tools/                 # Unix-style tools
│   │   │   ├── io/
│   │   │   ├── transform/
│   │   │   ├── search/
│   │   │   ├── format/
│   │   │   ├── ui/
│   │   │   └── index.ts
│   │   ├── runtime/               # Workspace runtime
│   │   ├── storage/               # Sandboxed storage
│   │   ├── session/               # Cookie sessions
│   │   └── meta-agent/            # Meta-agent
│   └── hooks/                     # React hooks
├── data/                          # User data (gitignored)
│   └── users/
├── public/
├── package.json
└── PLAN.md
```

---

## Next Steps

1. Scaffold Next.js project
2. Set up shadcn/ui + AI Elements
3. Implement session + sandboxed storage
4. Build core tools (read, write, filter, map)
5. Create WorkspaceRuntime with code execution
6. Build chat-table layout
7. Hardcode one workspace, test end-to-end
8. Then: meta-agent

Start with the runtime. Make one agent work. Then generate more.
