# Agent Studio

Agent Studio is a tile-based infinite-canvas workspace where a Claude Code style agent can research, write files, generate artifacts, and show results on a canvas.

The current architecture is:
- Next.js app as the control plane
- a separate workspace runner service for Claude execution
- Claude Code built-in tools as the primary execution surface
- thin app-specific MCP tools for canvas tiles and workspace metadata
- workspace files as the durable source of truth

## What It Does

You describe what you need in plain language. The agent can:
- read and edit workspace files
- run Bash and Python inside the workspace sandbox
- use web retrieval and web search
- generate real files like Markdown, CSV, HTML, PDF, PNG, or ZIP
- project those results onto the canvas as tiles

Example requests:
- "Create a markdown summary of these papers and show it on the canvas."
- "Build a CSV of recent AI publications and zip it for download."
- "Generate an HTML report and open it as a preview tile."
- "Read this PDF, extract the table, and show me a chart."

## Current Product Model

- `Files first`: if the agent creates something durable, it should exist as a real file in the workspace.
- `Tiles second`: tiles are views over files or derived workspace data.
- `Workspace Files`: files can be surfaced, shown on the canvas, and downloaded.
- `Chat grounding`: main chat can scope to selected tiles; contextual tile chat can reason about a specific tile or group.

## Available Surfaces

Canvas/UI tools currently support:
- tables
- charts
- cards
- markdown
- PDF tiles
- file-backed tiles and previews
- workspace metadata updates

The agent also has access to API/reference skills for supported research sources, including OpenAlex, Crossref, Semantic Scholar, arXiv, PubMed, WorldCat, CUNY Primo, and LibGuides.

## Requirements

- Node.js 20+
- Python 3.10+
- macOS or Linux with Claude Code sandbox support on the host

## Installation

```bash
git clone <repo-url>
cd agent-studio
npm install

python3 -m venv .venv
source .venv/bin/activate
pip install pandas numpy scipy scikit-learn matplotlib seaborn \
  pypdf pdfplumber openpyxl xlsxwriter pillow \
  python-docx python-pptx tqdm python-dateutil pytz

cp .env.example .env
```

Optional, using `uv`:

```bash
uv venv
source .venv/bin/activate
uv pip install pandas numpy scipy scikit-learn matplotlib seaborn \
  pypdf pdfplumber openpyxl xlsxwriter pillow \
  python-docx python-pptx tqdm python-dateutil pytz
```

## Environment Variables

Required:

```bash
SESSION_SECRET=<random-32-byte-hex>
CSRF_SECRET=<random-32-byte-hex>
```

Core optional settings:

```bash
COOKIE_SECURE=false
NEXT_PUBLIC_BASE_PATH=
DATA_DIR=data
PYTHON_VENV_PATH=.venv
```

Runner settings:

```bash
# App -> runner URL. The bundled dev/start scripts set this automatically.
WORKSPACE_RUNNER_BASE_URL=

# Runner bind host/port.
WORKSPACE_RUNNER_HOST=127.0.0.1
WORKSPACE_RUNNER_PORT=3200

# Optional shared secret between app and runner.
WORKSPACE_RUNNER_SHARED_SECRET=
```

Integration/API settings remain optional:

```bash
PRIMO_API_KEY=
OCLC_CLIENT_ID=
OCLC_CLIENT_SECRET=
LIBGUIDES_CLIENT_ID=
LIBGUIDES_CLIENT_SECRET=
OPENALEX_EMAIL=
```

## Running

Development:

```bash
npm run dev
```

This builds the runner, starts the runner service, waits for it to become healthy, and then starts the Next.js app.

Production:

```bash
npm run build
npm run start
```

Separate-process commands are also available:

```bash
npm run build:runner
npm run start:runner
npm run dev:app
npm run start:app
```

Open [http://localhost:3000](http://localhost:3000).

## How It Works

1. The app creates or loads a workspace and streams chat over SSE.
2. The Next.js app sends query execution to the separate runner service.
3. The runner hosts Claude plus the app MCP server for tile/workspace tools.
4. Claude uses built-in tools like `Read`, `Write`, `Edit`, `Bash`, `WebFetch`, `WebSearch`, and `ReadMcpResource`.
5. Durable outputs are written to the workspace filesystem.
6. Thin UI tools project those results to the canvas as tiles.
7. The app persists workspace state, messages, files, and tile layout.

## Workspace Features

- infinite canvas with movable, groupable, minimizable tiles
- compact `Workspace Files` shelf for durable artifacts
- file-backed tiles with `Show on Canvas`, `Go to Tile`, and `Download File`
- contextual tile chat and selection-aware main chat
- publish/clone flows for shared workspaces
- upload pipeline with validation and file previews
- responsive shell with canvas/chat tab switching on narrower widths

## Storage Layout

Each browser session gets isolated storage under:

```text
data/users/{session-id}/workspaces/{workspace-id}/
```

Important entries include:
- `config.json`
- `conversation.json`
- `ui.json`
- `files/`
- `.runtime-tmp/`
- tile data such as tables, charts, and cards

Contextual tile-chat requests are not persisted as normal conversation history.

## Security Model

- signed session cookies
- CSRF protection on mutating JSON routes
- per-session filesystem isolation in app storage
- separate runner process for Claude execution
- Claude sandbox scoped to the workspace files directory plus a private temp dir
- HTTP(S) egress proxy in the runner that blocks:
  - `localhost`
  - private IP ranges
  - cloud metadata endpoints
  - internal-only hostnames
- public internet access remains available for normal web research
- preview HTML isolation with CSP and origin separation

Important limitation: this is not yet kernel- or VM-level isolation. The current model is a separate runner process plus Claude sandboxing and egress controls, not per-workspace containers or microVMs.

## Testing

Automated:

```bash
npm run typecheck:strict
npm test
npm run build
```

Typical live smoke test:
- create a workspace
- ask the agent to create `smoke.md`
- ask the agent to create `smoke.zip` containing `smoke.md`
- verify both files appear in the workspace API / UI
- verify the ZIP download route serves `application/zip`

## Limits and Scope

- session-based, no persistent user accounts yet
- intended for public/open-web workflows, not internal sensitive CUNY data
- stronger infra isolation remains future work
- some research integrations require API keys

## Related Docs

- [CANVAS-DESIGN.md](./CANVAS-DESIGN.md): current canvas and tile model
- [PLAN.md](./PLAN.md): current architecture plan and next backend milestones

## License

[Your license here]
