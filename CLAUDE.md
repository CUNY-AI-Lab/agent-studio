# Agent Studio

A platform where CUNY community members describe what they need and get working AI agents. Built with Next.js, Claude Agent SDK, and shadcn/ui.

## Vision

**Skills = API docs. Agent = composer.**

Users describe a workflow → Agent discovers available APIs → Agent writes JavaScript → Code executes in sandbox → UI components render → User gets a working tool.

No pre-built specialized agents. Instead, a single powerful agent that:
1. Discovers capabilities via skill documents
2. Writes code to compose APIs
3. Builds dynamic interfaces
4. Learns from user feedback

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend                                 │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐            │
│  │  Chat   │  │  Table  │  │  Chart  │  │  Cards  │  ...       │
│  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘            │
│       └────────────┴────────────┴────────────┘                  │
│                         ↓                                        │
│                    UIState (panels)                              │
└─────────────────────────────────────────────────────────────────┘
                          ↑↓
┌─────────────────────────────────────────────────────────────────┐
│                      API Routes                                  │
│  /api/workspaces/[id]/query  ←──  Agent + Execute Tool          │
└─────────────────────────────────────────────────────────────────┘
                          ↑↓
┌─────────────────────────────────────────────────────────────────┐
│                   Execute Tools                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  execute (JavaScript VM)                                  │  │
│  │  - read/write (data I/O)                                  │  │
│  │  - filter/pick/sort/map (transforms)                      │  │
│  │  - setTable/setChart/setCards (UI)                        │  │
│  │  - fetch (HTTP) + listSkills/readSkill (API discovery)    │  │
│  │  - download (file output)                                 │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  execute_python (Sandbox Manager - port 8765)             │  │
│  │  - pandas, numpy (data processing)                        │  │
│  │  - pypdf, pdfplumber (PDF)                                │  │
│  │  - openpyxl (Excel)                                       │  │
│  │  - matplotlib (visualization)                             │  │
│  │  - Persistent state per workspace                         │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                          ↑↓
┌─────────────────────────────────────────────────────────────────┐
│                    Storage Layer                                 │
│  data/users/{userId}/workspaces/{workspaceId}/                  │
│    ├── config.json     # Workspace config                        │
│    ├── ui.json         # Panel layout                            │
│    ├── conversation.json                                         │
│    ├── tables/*.json   # Table data                              │
│    ├── charts/*.json   # Chart data                              │
│    ├── cards/*.json    # Cards data                              │
│    └── files/*         # User files                              │
└─────────────────────────────────────────────────────────────────┘
```

## Key Files

### Core
- `src/lib/tools/code/execute.ts` - JavaScript execution sandbox
- `src/lib/tools/sandbox.ts` - Python sandbox client
- `src/lib/storage/index.ts` - Per-user sandboxed storage
- `src/lib/session.ts` - Session management
- `src/app/api/workspaces/[id]/query/route.ts` - Agent query endpoint

### Sandbox Manager (Python)
- `sandbox/manager.py` - FastAPI service managing persistent Python sessions
- `sandbox/requirements.txt` - Python dependencies
- `sandbox/Dockerfile` - Container definition
- `sandbox/run.sh` - Development startup script

### Skills (API Documentation)
- `src/lib/skills/index.json` - Skill index
- `src/lib/skills/openalex.md` - OpenAlex API
- `src/lib/skills/worldcat.md` - WorldCat API (OAuth)
- `src/lib/skills/primo.md` - Primo API
- `src/lib/skills/libguides.md` - LibGuides API

### UI
- `src/app/w/[id]/page.tsx` - Workspace page with dynamic panels
- `src/components/ui/*` - shadcn components

## Execute Sandbox Functions

### Data I/O
```javascript
await read("table:users")           // Read table data
await read("file:data.json")        // Read file
await read("chart:trends")          // Read chart data
await read("cards:papers")          // Read cards data
await read("markdown:notes")        // Read markdown content
await write(data, "table:results")  // Write to table
await write(data, "file:out.json")  // Write to file
```

### Transforms
```javascript
filter(data, "status == 'active'")  // Filter array
pick(data, ["name", "email"])       // Select fields
sort(data, "date", "desc")          // Sort
map(data, fn)                       // Transform each item
unique(data, "id")                  // Deduplicate
group(data, "category")             // Group by field
```

### UI Components
```javascript
await setTable("results", {
  title: "Search Results",
  columns: [
    { key: "title", label: "Title", type: "text" },
    { key: "year", label: "Year", type: "number" }
  ],
  data: [...]
})

await setChart("trends", {
  type: "bar",  // bar, line, pie, area
  data: [...],
  xKey: "year",
  yKey: "count"
})

await setCards("papers", {
  title: "Papers",
  items: [
    { title: "...", subtitle: "...", description: "..." }
  ]
})

await setMarkdown("notes", {
  title: "Notes",
  content: "# Heading\n\nMarkdown content..."
})

await addPanel({ id: "custom", type: "preview", content: "<html>..." })
await removePanel("panel-id")
```

### HTTP & APIs
```javascript
// Discovery
const skills = await listSkills()           // [{name, description}]
const docs = await readSkill("openalex")    // API documentation
const apiKey = env("PRIMO_API_KEY")         // Environment variable

// HTTP
const res = await fetch("https://api.openalex.org/works?search=...")
const data = await res.json()

// XML parsing (for APIs like arXiv, PubMed)
const xml = await res.text()
const parsed = parseXML(xml)                // Convert XML to JSON object
```

### Output
```javascript
await download("results.csv", data, "csv")   // Trigger browser download
await download("data.json", data, "json")
```

## Panel Types

| Type | Description | Config |
|------|-------------|--------|
| `chat` | Conversation | - |
| `table` | Data table | `tableId` |
| `chart` | Visualization | `chartId` |
| `cards` | Card grid | `cardsId` |
| `markdown` | Rich text | `content` |
| `editor` | Code editor | `filePath` |
| `preview` | HTML preview | `content` |
| `fileTree` | File browser | - |
| `detail` | Detail view | `linkedTo` |

## Environment Variables

```bash
# Primo (library catalog)
PRIMO_API_KEY=...
PRIMO_VID=...                    # View ID, institution-specific
PRIMO_SCOPE=...                  # Search scope
PRIMO_BASE_URL=https://api-na.hosted.exlibrisgroup.com/primo/v1/search
PRIMO_DISCOVERY_URL=...          # Discovery UI base URL for catalog links

# OpenAlex (optional, for polite pool)
OPENALEX_EMAIL=...

# WorldCat (OCLC)
OCLC_CLIENT_ID=...
OCLC_CLIENT_SECRET=...
OCLC_INSTITUTION_ID=ZGM

# LibGuides
LIBGUIDES_SITE_ID=...
LIBGUIDES_CLIENT_ID=...
LIBGUIDES_CLIENT_SECRET=...
LIBGUIDES_BASE_URL=https://lgapi-us.libapps.com/1.2
```

## Adding New Skills

1. Create `src/lib/skills/{name}.md` with API documentation
2. Add entry to `src/lib/skills/index.json`
3. Add any required env vars to `.env`

Skill format:
```markdown
# API Name

## Overview
What this API does. Auth requirements.

## Base URL
https://api.example.com

## Endpoints
### Endpoint Name
GET /path?param={value}

## Response Format
{...}

## Example Code
```javascript
const res = await fetch('...')
```

## Environment Variables
API_KEY - description
```

## Adding New Panel Types

1. Add type to `UIPanel` interface in `src/lib/storage/index.ts`
2. Add data interface if needed (like `ChartData`)
3. Add storage methods if needed
4. Add sandbox function in `src/lib/tools/code/execute.ts`
5. Add panel component in `src/app/w/[id]/page.tsx`
6. Update tool description in execute.ts

## Design Decisions

### Why code execution over pre-built tools?
- Composability: Agent combines primitives freely
- Flexibility: No need to anticipate every use case
- Discoverability: Skills teach the agent on demand
- Maintenance: Add capabilities by adding docs, not code

### Why skills over hardcoded tools?
- Token efficiency: Only load what's needed
- Extensibility: Users can add their own skills
- Self-documenting: Skills ARE the documentation
- Progressive disclosure: Agent learns as it explores

### Why per-user storage?
- Privacy: Each user's data is isolated
- Simplicity: No complex permissions
- Portability: Easy to export/backup

## Common Patterns

### Agent workflow
1. User asks for something
2. Agent discovers relevant skills
3. Agent writes code using sandbox functions
4. Code executes, updates storage
5. UI re-renders with new data
6. Agent explains what it did

### API integration
```javascript
// 1. Read skill docs
const docs = await readSkill("openalex")

// 2. Get any needed credentials
const email = env("OPENALEX_EMAIL")

// 3. Make API call
const res = await fetch(`https://api.openalex.org/works?search=...&mailto=${email}`)
const { results } = await res.json()

// 4. Display results
await setTable("papers", {
  title: "Papers",
  columns: [...],
  data: results.map(r => (...))
})

return "Found " + results.length + " papers"
```

## Tech Stack

- **Framework**: Next.js 15 (App Router)
- **AI**: Claude Agent SDK (@anthropic-ai/claude-agent-sdk)
- **UI**: shadcn/ui + Tailwind CSS
- **Charts**: Recharts (via shadcn chart component)
- **Runtime**: Node.js vm module for sandboxed execution

## Development

```bash
# Terminal 1: Start Next.js dev server
npm run dev

# Terminal 2: Start Python sandbox manager (requires Docker)
cd sandbox && ./run.sh

# Or without Docker (dev only, not sandboxed):
cd sandbox && python manager.py
```

Build:
```bash
npm run build    # Build for production
npm run start    # Start production server
```

## Testing

### Browser Testing
Create a workspace at http://localhost:3000, then test with prompts like:
- "What skills are available?"
- "Search OpenAlex for machine learning papers and show me the results"
- "Create a chart showing publication counts by year"
- "Export these results as CSV"

### CLI Testing (for Claude Code)

The API uses session cookies. First get a session, then interact with workspaces:

```bash
# Store cookies
COOKIE_FILE="/tmp/agent-studio-cookies.txt"

# 1. Get session cookie by visiting homepage
curl -s -c "$COOKIE_FILE" http://localhost:3000 > /dev/null

# 2. Create a workspace (uses form data, follows redirect)
RESPONSE=$(curl -s -b "$COOKIE_FILE" -c "$COOKIE_FILE" -L -w "\n%{url_effective}" \
  -X POST http://localhost:3000/api/create \
  -F "description=Test workspace for exploring OpenAlex API")
WORKSPACE_ID=$(echo "$RESPONSE" | tail -1 | sed 's|.*/w/||')
echo "Created workspace: $WORKSPACE_ID"

# 3. Check workspace state
curl -s -b "$COOKIE_FILE" "http://localhost:3000/api/workspaces/$WORKSPACE_ID" | jq '{
  name: .workspace.name,
  panels: [.uiState.panels[].type],
  tables: (.tables | length),
  charts: (.charts | keys),
  messages: (.messages | length)
}'

# 4. Send a query
curl -s -b "$COOKIE_FILE" -X POST "http://localhost:3000/api/workspaces/$WORKSPACE_ID/query" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "What skills are available? List them."}' -o /tmp/response.txt
cat /tmp/response.txt

# 5. Check updated state
curl -s -b "$COOKIE_FILE" "http://localhost:3000/api/workspaces/$WORKSPACE_ID" > /tmp/ws.json
jq '.uiState.panels' /tmp/ws.json
jq '.tables' /tmp/ws.json
jq '.charts' /tmp/ws.json
```

### Test Scenarios

| Test | Prompt | Expected Result |
|------|--------|-----------------|
| Skill Discovery | "What skills are available?" | Lists openalex, worldcat, primo, libguides |
| Table Creation | "Search OpenAlex for ML papers, show top 5" | Creates table panel with data |
| Chart Creation | "Chart ML papers by year 2020-2024" | Creates bar chart panel |
| Cards Creation | "Show top 3 papers as cards" | Creates cards panel |
| File Export | "Export the data as CSV" | Creates downloadable file |
| API Discovery | "Read the OpenAlex documentation" | Returns skill markdown |

### Verifying Results

After sending queries, check the workspace state:

```bash
# Get full state
curl -s -b "$COOKIE_FILE" "http://localhost:3000/api/workspaces/$WORKSPACE_ID" > /tmp/ws.json

# Check panels created
jq '.uiState.panels[] | "\(.type): \(.title // .id)"' /tmp/ws.json

# Check table data
jq '.tables[0].data | length' /tmp/ws.json

# Check chart data
jq '.charts | keys' /tmp/ws.json

# Check messages
jq '.messages | length' /tmp/ws.json
```

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Homepage (sets session cookie) |
| POST | `/api/create` | Create workspace (form data: description) |
| GET | `/api/workspaces/[id]` | Get workspace state |
| POST | `/api/workspaces/[id]/query` | Send query (JSON: prompt) |
| PATCH | `/api/workspaces/[id]` | Update workspace |
| DELETE | `/api/workspaces/[id]` | Delete workspace |
| DELETE | `/api/workspaces/[id]/downloads` | Clear pending downloads |
