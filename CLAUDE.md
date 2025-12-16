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
│  /api/workspaces/[id]/query  ←──  Agent + MCP Tools             │
└─────────────────────────────────────────────────────────────────┘
                          ↑↓
┌─────────────────────────────────────────────────────────────────┐
│                   Execution Tools                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  execute (JavaScript VM - 30s timeout)                    │  │
│  │  - read/write (data I/O)                                  │  │
│  │  - filter/pick/sort/map (transforms)                      │  │
│  │  - setTable/setChart/setCards (UI)                        │  │
│  │  - fetch (HTTP) + listSkills/readSkill (API discovery)    │  │
│  │  - download (file output)                                 │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Bash + Python (Local venv, sandboxed via bubblewrap)     │  │
│  │  - pandas, numpy, scipy, scikit-learn (data processing)   │  │
│  │  - pypdf, pdfplumber, openpyxl (file processing)          │  │
│  │  - matplotlib, seaborn (visualization)                    │  │
│  │  - Fast local execution via SDK sandbox                   │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Built-in SDK Tools                                       │  │
│  │  - WebFetch (fetch web content)                           │  │
│  │  - WebSearch (search the web)                             │  │
│  │  - Skill (execute skills)                                 │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                          ↑↓
┌─────────────────────────────────────────────────────────────────┐
│                    Storage Layer                                 │
│  data/users/{sessionId}/workspaces/{workspaceId}/               │
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
- `src/lib/runtime/index.ts` - Agent SDK runtime (model: claude-sonnet-4-20250514)
- `src/lib/tools/code/execute.ts` - JavaScript execution sandbox (Node.js vm, 30s timeout)
- `src/lib/tools/index.ts` - Tool registry (12 MCP tools)
- `src/lib/storage/index.ts` - Per-user sandboxed storage with path traversal protection
- `src/lib/session.ts` - Session management (HMAC-SHA256 signed cookies)
- `src/app/api/workspaces/[id]/query/route.ts` - Agent query endpoint with streaming

### Python Execution (Local venv via Bash)
Python code executes locally via the Agent SDK's Bash tool in sandbox mode:
- **Venv location**: `/home/zweb/apps/agent-studio/.venv`
- **Pre-installed libraries**: pandas, numpy, scipy, scikit-learn, matplotlib, seaborn, pypdf, pdfplumber, openpyxl, xlsxwriter, pillow, python-docx, python-pptx, tqdm, python-dateutil, pytz
- **Sandbox**: Uses bubblewrap (Linux) with `autoAllowBashIfSandboxed: true`
- **Fast execution**: Direct local execution, no nested API calls

Example Python via Bash:
```bash
/home/zweb/apps/agent-studio/.venv/bin/python3 -c "
import pandas as pd
print(pd.DataFrame({'a': [1,2,3]}).describe())
"
```

### Skills (API Documentation)
Located in `src/lib/skills/`:

**Academic APIs (no auth):**
- `openalex.md` - Scholarly papers (150M+ works)
- `crossref.md` - DOI registry (150M+ papers)
- `semantic-scholar.md` - AI-powered search with summaries
- `arxiv.md` - Preprints (physics, math, CS, AI/ML)
- `pubmed.md` - Biomedical literature (35M+ citations)

**Library APIs:**
- `worldcat.md` - Books across 10,000+ libraries (OAuth)
- `primo.md` - CUNY OneSearch/catalog (API key)
- `libguides.md` - Research guides (OAuth)

**Data/Search:**
- `unpaywall.md` - Open access paper versions
- `wikipedia.md` - General knowledge
- `nyc-opendata.md` - NYC datasets via Socrata API
- `census.md` - US Census Bureau data

**Document Processing:**
- `pdf.md` - Extract/create/merge PDFs
- `xlsx.md` - Excel files
- `docx.md` - Word documents
- `pptx.md` - PowerPoint presentations

**Visualization:**
- `leaflet.md` - Interactive maps
- `threejs.md` - 3D visualizations
- `network-graph.md` - Force-directed network graphs

**Utilities:**
- `frontend-design.md` - UI design guidelines
- `citation.md` - Citation formatting (APA, MLA, Chicago)

### UI
- `src/app/w/[id]/page.tsx` - Workspace page with infinite canvas (@flowscape-ui/canvas-react)
- `src/components/ui/*` - shadcn components

## MCP Tools (12 total)

| Tool | Description |
|------|-------------|
| `execute` | JavaScript VM sandbox with all functions below |
| `read` | Read from tables, files, charts, cards, markdown |
| `write` | Write to tables or files |
| `filter` | Filter array by condition |
| `pick` | Select specific fields |
| `sort` | Sort by field |
| `ui.table` | Create/update data table |
| `ui.message` | Display message to user |
| `ui.addPanel` | Add panel dynamically |
| `ui.removePanel` | Remove panel |
| `ui.updatePanel` | Update panel properties |
| `ui.setLayout` | Set workspace layout |

Plus SDK built-in: `Bash`, `WebFetch`, `WebSearch`, `Skill`

## Execute Sandbox Functions

### Data I/O
```javascript
await read("table:users")           // Read table data
await read("file:data.json")        // Read file (text, JSON, PDF)
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
    { key: "year", label: "Year", type: "number" },
    { key: "url", label: "Link", type: "url", linkText: "View" }
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
    { title: "...", subtitle: "...", description: "...", badge: "Open Access" }
  ]
})

await setMarkdown("notes", {
  title: "Notes",
  content: "# Heading\n\nMarkdown content..."
})

await addPanel({ id: "custom", type: "preview", content: "<html>...", layout: { x: 50, y: 50, width: 600, height: 400 } })
await removePanel("panel-id")
await updatePanel("panel-id", { title: "New Title" })
await movePanel("panel-id", { x: 700, y: 50, width: 600, height: 400 })
```

### HTTP & APIs
```javascript
// Discovery
const skills = await listSkills()           // [{name, description}]
const docs = await readSkill("openalex")    // API documentation markdown
const apiKey = env("PRIMO_API_KEY")         // Environment variable (whitelisted)

// HTTP
const res = await fetch("https://api.openalex.org/works?search=...")
const data = await res.json()

// XML parsing (for arXiv, PubMed)
const xml = await res.text()
const parsed = parseXML(xml)                // Convert XML to JSON object
```

### File Operations
```javascript
const files = await listFiles()             // List workspace files
await deleteFile("old-data.csv")            // Delete file
const matches = await glob("*.json")        // Glob pattern match
const results = await search("keyword")     // Search file contents
await edit("file.txt", "old", "new")        // Edit file content
```

### Output
```javascript
await download("results.csv", data, "csv")   // Trigger browser download
await download("data.json", data, "json")
log("Debug message")                         // Console logging
```

## Panel Types

| Type | Description | Config |
|------|-------------|--------|
| `chat` | Conversation | - |
| `table` | Data table | `tableId` |
| `chart` | Visualization | `chartId` |
| `cards` | Card grid | `cardsId` |
| `markdown` | Rich text | `content` or `markdownId` |
| `editor` | Code editor | `filePath` |
| `preview` | HTML preview | `content` |
| `fileTree` | File browser | - |
| `detail` | Detail view | `linkedTo` |

## Environment Variables

```bash
# Required
ANTHROPIC_API_KEY=sk-ant-...         # Claude API key

# Primo (CUNY library catalog)
PRIMO_API_KEY=...
PRIMO_VID=01CUNY_GC:CUNY_GC
PRIMO_SCOPE=IZ_CI_AW
PRIMO_BASE_URL=https://api-na.hosted.exlibrisgroup.com/primo/v1/search
PRIMO_DISCOVERY_URL=https://cuny-gc.primo.exlibrisgroup.com

# OpenAlex (optional, for polite pool)
OPENALEX_EMAIL=...

# WorldCat (OCLC)
OCLC_CLIENT_ID=...
OCLC_CLIENT_SECRET=...
OCLC_INSTITUTION_ID=ZGM

# LibGuides
LIBGUIDES_SITE_ID=146
LIBGUIDES_CLIENT_ID=961
LIBGUIDES_CLIENT_SECRET=...
LIBGUIDES_BASE_URL=https://lgapi-us.libapps.com/1.2

# Optional
SESSION_SECRET=...                   # Session signing key
CSRF_SECRET=...                      # CSRF token secret
DATA_DIR=data                        # Storage location
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Homepage (sets session cookie) |
| POST | `/api/create` | Create workspace (form: prompt, blank) |
| GET | `/api/workspaces` | List user's workspaces |
| GET | `/api/workspaces/[id]` | Get workspace state |
| PATCH | `/api/workspaces/[id]` | Update workspace |
| DELETE | `/api/workspaces/[id]` | Delete workspace |
| POST | `/api/workspaces/[id]/query` | Send prompt (streams SSE) |
| POST | `/api/workspaces/[id]/query/abort` | Abort running query |
| POST | `/api/workspaces/[id]/upload` | Upload files (10MB/file, 50MB total) |
| POST | `/api/workspaces/[id]/publish` | Publish to gallery |
| PATCH | `/api/workspaces/[id]/layout` | Update panel layout |
| GET/PATCH/DELETE | `/api/workspaces/[id]/panels/[panelId]` | Manage panels |
| GET/DELETE | `/api/workspaces/[id]/downloads` | Manage downloads |
| GET | `/api/gallery` | List gallery items |
| GET/POST/DELETE | `/api/gallery/[id]` | View/clone/unpublish |
| GET | `/api/preview` | Preview panel content |

## Security

### Session Management
- Signed cookies with HMAC-SHA256
- 7-day expiration
- Constant-time signature comparison

### CSRF Protection
- Token-based validation
- httpOnly, secure, sameSite=strict

### Code Execution Sandbox
- Node.js vm module with 30-second timeout
- Whitelist of allowed globals (no require, no process, no fs)
- setInterval disabled (DoS prevention)
- setTimeout limited to 30 seconds

### Bash Sandbox
- bubblewrap (bwrap) on Linux
- Network/filesystem isolation
- Auto-approved only when sandboxed

### File Upload
- MIME type validation
- Extension whitelist
- Filename sanitization (alphanumeric + dash/underscore)
- Size limits: 10MB/file, 50MB total, 10 files max

### Storage
- Path traversal prevention
- Per-user isolation by session ID

## Development

### Prerequisites
- Node.js 18+
- bubblewrap (`apt install bubblewrap`)
- Python 3.10+ (for venv)

### Setup
```bash
npm install
python3 -m venv .venv
source .venv/bin/activate
pip install pandas numpy scipy scikit-learn matplotlib seaborn pypdf pdfplumber openpyxl xlsxwriter pillow python-docx python-pptx tqdm python-dateutil pytz
```

### Run
```bash
npm run dev      # Start dev server at http://localhost:3000
npm run build    # Build for production
npm run start    # Start production server
```

## Testing

### Browser Testing
Create a workspace at http://localhost:3000, then test:
- "What skills are available?"
- "Search OpenAlex for machine learning papers"
- "Create a chart of papers by year"
- "Run this Python: print(42 + 1)"

### CLI Testing
```bash
# Get session
curl -c /tmp/cookies.txt http://localhost:3000 > /dev/null

# Create workspace
curl -b /tmp/cookies.txt -c /tmp/cookies.txt -L \
  -X POST http://localhost:3000/api/create -F "blank=true"

# Query (requires CSRF token from cookies)
CSRF=$(grep csrf-token /tmp/cookies.txt | awk '{print $7}')
curl -b /tmp/cookies.txt -X POST "http://localhost:3000/api/workspaces/WORKSPACE_ID/query" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: $CSRF" \
  -d '{"prompt": "hi"}'
```

## Adding New Skills

1. Create `src/lib/skills/{name}.md` with API documentation
2. Add entry to `src/lib/skills/index.json`
3. Add any required env vars to `.env`

## Adding New Panel Types

1. Add type to `UIPanel` interface in `src/lib/storage/index.ts`
2. Add data interface if needed (like `ChartData`)
3. Add storage methods if needed
4. Add sandbox function in `src/lib/tools/code/execute.ts`
5. Add panel component in `src/app/w/[id]/page.tsx`

## Design Decisions

### Why code execution over pre-built tools?
- Composability: Agent combines primitives freely
- Flexibility: No need to anticipate every use case
- Discoverability: Skills teach the agent on demand

### Why skills over hardcoded tools?
- Token efficiency: Only load what's needed
- Extensibility: Users can add their own skills
- Self-documenting: Skills ARE the documentation

### Why per-user storage?
- Privacy: Each user's data is isolated
- Simplicity: No complex permissions
- Portability: Easy to export/backup

## Tech Stack

- **Framework**: Next.js 15 (App Router)
- **AI**: Claude Agent SDK with claude-sonnet-4-20250514
- **UI**: shadcn/ui + Tailwind CSS + @flowscape-ui/canvas-react (infinite canvas)
- **Charts**: Recharts
- **Runtime**: Node.js vm (JS) + bubblewrap (Bash/Python)
- **Storage**: Filesystem-based JSON
