# Agent Studio

A workspace where you describe what you need and an AI agent builds it. The agent can search academic databases, process documents, create visualizations, and build interactive tools.

## What it does

You type a request in plain English. The agent figures out which APIs to call, writes code to process the data, and creates UI components to display results. Everything happens in a workspace with draggable panels on an infinite canvas.

**Example requests:**
- "Search for recent papers on climate change and show me a table"
- "Find books about machine learning at CUNY libraries"
- "Create a chart showing publication trends in AI research"
- "Build a tool that converts PDFs to text"

## Available capabilities

### Research
- **OpenAlex** - 150M+ scholarly papers
- **Crossref** - DOI lookups and citation data
- **Semantic Scholar** - AI-powered paper search with summaries
- **arXiv** - Preprints in physics, math, CS, AI/ML
- **PubMed** - 35M+ biomedical citations
- **Unpaywall** - Find open access versions of papers

### Libraries
- **WorldCat** - Books across 10,000+ libraries worldwide
- **CUNY OneSearch** - CUNY library catalog
- **LibGuides** - Research guides by subject

### Data
- **NYC Open Data** - City datasets (demographics, transit, housing, etc.)
- **US Census** - Population, economic, and housing statistics
- **Wikipedia** - General knowledge lookups

### Documents
- **PDF** - Extract text, create new PDFs, merge/split
- **Excel** - Read/write spreadsheets with formulas
- **Word** - Create and edit documents
- **PowerPoint** - Generate presentations

### Visualization
- **Tables** - Sortable data tables with links
- **Charts** - Bar, line, pie, area charts
- **Maps** - Interactive maps with markers
- **Network graphs** - Relationship visualizations
- **3D** - Three.js visualizations

## Setup

### Requirements
- Node.js 18+
- Python 3.10+
- Linux with bubblewrap (`apt install bubblewrap`)

### Installation

```bash
# Clone and install
git clone <repo-url>
cd agent-studio
npm install

# Set up Python environment
python3 -m venv .venv
source .venv/bin/activate
pip install pandas numpy scipy scikit-learn matplotlib seaborn \
    pypdf pdfplumber openpyxl xlsxwriter pillow \
    python-docx python-pptx tqdm python-dateutil pytz

# Configure environment
cp .env.example .env
# Edit .env with your API keys
```

Optional (faster Python setup with uv):

```bash
uv venv
source .venv/bin/activate
uv pip install pandas numpy scipy scikit-learn matplotlib seaborn \
    pypdf pdfplumber openpyxl xlsxwriter pillow \
    python-docx python-pptx tqdm python-dateutil pytz
```

### Environment variables

Required:
```
# Security - generate with: openssl rand -hex 32
SESSION_SECRET=<random-32-byte-hex>
CSRF_SECRET=<random-32-byte-hex>
```

Note: In production, the app fails to start if these are missing.

Production:
```
# Set to true only if using HTTPS
COOKIE_SECURE=true
```

Optional (for specific features):
```
# CUNY library search
PRIMO_API_KEY=...

# WorldCat book search
OCLC_CLIENT_ID=...
OCLC_CLIENT_SECRET=...

# LibGuides
LIBGUIDES_CLIENT_ID=...
LIBGUIDES_CLIENT_SECRET=...

# Better rate limits on OpenAlex
OPENALEX_EMAIL=your@email.edu

# Custom Python venv location (defaults to .venv in project root)
PYTHON_VENV_PATH=/path/to/venv

# Base path for deployment at a subpath (e.g., /studio)
NEXT_PUBLIC_BASE_PATH=/studio

# Override data directory (defaults to ./data)
DATA_DIR=/path/to/data
```

### Running

```bash
# Development
npm run dev

# Production
npm run build
npm run start

# Tests (Node built-in runner)
npm run test

# Strict typecheck for unused code (optional)
npm run typecheck:strict
```

Open http://localhost:3000

## How it works

1. **You describe what you want** in the chat panel
2. **The agent reads skill documents** to learn available APIs
3. **The agent writes JavaScript** to fetch data and transform it
4. **Code runs in a sandbox** with a 30-second CPU limit and a 2-minute async cap
5. **Results stream back** over SSE (tokens, tool status, panel updates)
6. **Results appear as panels** - tables, charts, cards, or custom HTML

The agent can also run Python for data processing (pandas, numpy, matplotlib) and Bash commands in a sandboxed environment.

## Workspace features

- **Infinite canvas** - Pan and zoom, arrange panels anywhere
- **Draggable panels** - Resize and reposition tables, charts, etc.
- **Contextual chat** - Ask about a specific panel or group in a side popover
- **Grouping** - Group panels, rename groups, and move them together
- **Connections** - New panels can be linked to the panel that spawned them
- **Minimize** - Hide panels to a dock and restore them later
- **File uploads** - Upload CSVs, PDFs, images (10MB limit per file)
- **Downloads** - Export results as CSV or JSON
- **Gallery** - Share workspaces publicly for others to clone

## Data storage

Each user gets isolated storage. Your data is stored in:
```
data/users/{your-session-id}/workspaces/{workspace-id}/
```

Files include:
- `config.json` - Workspace name and settings
- `conversation.json` - Chat history
- `ui.json` - Panel layout
- `tables/*.json` - Table data
- `charts/*.json` - Chart configurations
- `files/*` - Uploaded files

Sessions last 7 days. There's no account system - your browser cookie identifies you. Contextual chat messages are not persisted in `conversation.json`.

## Adding new skills

Skills are markdown files that teach the agent how to use an API. To add one:

1. Create `src/lib/skills/{name}.md` with:
   - API endpoint documentation
   - Authentication requirements
   - Example requests and responses
   - Rate limits and usage notes

2. Add to `src/lib/skills/index.json`:
   ```json
   {
     "name": "my-api",
     "description": "What this API does and example queries"
   }
   ```

3. Add any required environment variables to `.env`

The agent will discover and use new skills automatically.

## Security

- **Code sandbox**: JavaScript runs in Node.js vm with restricted globals
- **Bash sandbox**: Commands run in bubblewrap with network/filesystem isolation
- **User isolation**: Each session has separate storage, no cross-user access
- **File validation**: Uploads checked for type, extension, and size
- **CSRF protection**: State-changing requests require tokens
- **Signed sessions**: Cookies use HMAC-SHA256 signatures
- **Preview isolation**: Preview HTML is served with a CSP sandbox and same-origin framing restriction; network access is allowed, but the page runs in a unique origin and cannot access site cookies.

## Limitations

- 30-second CPU limit with a 2-minute async cap on code execution
- 10MB per uploaded file, 50MB total per workspace
- No persistent accounts (session-based only)
- Some APIs require authentication keys
- Bash/Python sandboxing requires Linux with bubblewrap

## Technical details

See [CLAUDE.md](./CLAUDE.md) for:
- Architecture diagrams
- API endpoint reference
- Sandbox function documentation
- Panel type specifications
- Development guidelines

## License

[Your license here]
