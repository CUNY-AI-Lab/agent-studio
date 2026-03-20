# Agent Studio Plan

This file reflects the current architecture and next milestones. It replaces the older execute-era plan.

## Current State

Agent Studio is now built around five decisions:

1. The Next.js app is the control plane.
2. Claude execution happens through a separate runner service.
3. Claude Code built-in tools are the primary execution surface.
4. App-specific tools are thin UI/MCP tools for tiles and workspace metadata.
5. Workspace files are the durable source of truth.

## Shipped Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│                        Next.js App                           │
│                                                              │
│  - session + CSRF                                            │
│  - workspace storage                                         │
│  - canvas/tile UI                                            │
│  - SSE bridge to runner                                      │
└───────────────────────┬──────────────────────────────────────┘
                        │ HTTP/SSE
┌───────────────────────▼──────────────────────────────────────┐
│                    Workspace Runner                          │
│                                                              │
│  - Claude Agent SDK query()                                  │
│  - Claude Code built-in tools                                │
│  - MCP server for tile/workspace tools                       │
│  - workspace-scoped sandbox                                  │
│  - HTTP(S) egress proxy                                      │
└───────────────────────┬──────────────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────────────┐
│                   Workspace Filesystem                       │
│                                                              │
│  data/users/{session}/workspaces/{workspace}/                │
│    - config.json                                             │
│    - conversation.json                                       │
│    - ui.json                                                 │
│    - files/                                                  │
│    - .runtime-tmp/                                           │
└──────────────────────────────────────────────────────────────┘
```

## Current Execution Contract

Claude should use built-in tools for:
- file reads/writes/edits
- Bash
- Python and local artifact generation
- web retrieval and search
- MCP resource reads

The app tool layer should only handle:
- table/chart/cards/markdown/PDF/file tile projection
- workspace title/description updates
- low-level tile add/update/remove operations

The app should not reintroduce a second generic execution runtime like the old `execute` tool.

## Current Security Contract

What exists now:
- per-session filesystem isolation in app storage
- separate runner service instead of app-process execution
- Claude sandbox scoped to workspace files plus temp
- no bypass-permissions mode
- host/internal HTTP(S) egress blocking through the runner proxy

What the proxy blocks:
- `localhost`
- private IP ranges
- cloud metadata endpoints
- internal-only hostnames

What remains true:
- broad public internet access is allowed
- this is not yet kernel- or VM-level isolation

## Current Product Contract

- files are durable artifacts
- tiles are views over files or derived data
- the canvas is the primary workspace
- chat can work globally or in the scope of selected tiles
- ZIPs and similar artifacts are real workspace files, not fake inline downloads

## Repository Map

Important current paths:

- `src/app/w/[id]/page.tsx`
  Workspace UI, canvas shell, files shelf, chat, tile actions

- `src/app/api/workspaces/[id]/query/route.ts`
  App-side SSE endpoint that forwards execution to the runner

- `src/lib/runtime/index.ts`
  App runtime factory, remote-runner only

- `src/lib/runtime/remote.ts`
  Remote runner client

- `src/runner/server.ts`
  Separate runner service

- `src/lib/runtime/in-process.ts`
  Runner-internal Claude runtime implementation

- `src/runner/egress-proxy.ts`
  HTTP(S) egress filter for localhost/private/internal destinations

- `src/lib/workspace/defaults.ts`
  Default system prompt and tool contract

## What Is Done

- remote runner cutover
- legacy execute-era workspace normalization
- file-first artifact model
- tile-first product language in the UI
- ZIP and file artifact delivery through workspace files
- localhost/private/internal HTTP(S) blocking at the runner boundary
- responsive workspace shell cleanup

## Must-Have Next Steps

1. Stronger execution isolation at deployment time
   The current runner split is the right shape, but the long-term answer is a stronger boundary such as container, sandbox-runtime, gVisor, or VM.

2. Browser-level QA / e2e coverage
   The repo has strong unit coverage and repeated live API smoke checks, but it still needs deeper browser automation or manual click-through coverage around canvas behavior.

3. Deployment hardening
   Run the runner as an explicit production service, wire shared-secret auth where appropriate, and document deployment topology clearly.

4. Continued UX cleanup
   Keep refining the file shelf, tile menus, compact layout behavior, and file-backed preview behavior as one coherent system.

## Explicit Non-Goals

- bringing back the old `execute` / `read` / `write` / `filter` / `pick` / `sort` runtime model
- treating tiles as the durable source of truth instead of files
- special-case one-off export features in place of real artifact creation

## How To Evaluate Changes

A change is aligned if it preserves these rules:

- Claude can do broad work through built-in tools.
- Durable outputs land in the workspace filesystem.
- The UI surfaces those outputs as files and/or tiles.
- The app layer stays a control plane plus thin canvas semantics.
- Security improvements strengthen the runner boundary instead of reintroducing app-process execution.
