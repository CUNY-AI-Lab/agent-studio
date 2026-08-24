# Agent Studio Canvas Model

Status: current product vocabulary and design model. The open questions are
unresolved product decisions, not implementation commitments.

This document describes the current product model for the canvas. Earlier drafts described a transition from a panel system to a canvas. That transition has effectively happened; the current product language is `tile`.

## Core Model

Agent Studio is an infinite canvas made of tiles.

The canvas has no positive-coordinate origin boundary: users can pan and place
tiles in any direction, including above and left of their starting view. New
tiles are placed in the current viewport instead of being pulled back toward
the initial origin.

Three concepts matter:
- `Files`: durable workspace artifacts
- `Tiles`: canvas views over files or derived data
- `Chat`: the agent interface that can work globally or in the context of selected tiles

The key rule is:

> Files are the source of truth. Tiles are views.

If the agent says it created something durable, it should exist as a real file in the workspace first.

## Workspace Shell

The workspace shell has three layers:

1. `Workspace Files`
   A compact file shelf that surfaces durable artifacts.

2. `Canvas`
   The main infinite canvas where tiles live, move, group, minimize, and connect.

3. `Chat`
   The primary conversation surface, docked on wide screens and tabbed on narrower ones.

On smaller widths, canvas and chat switch through a segmented tab control instead of overlapping.

## Tile Types

Current user-facing tile categories:
- markdown tiles
- table/CSV tiles
- chart tiles
- cards tiles
- PDF tiles
- HTML/file preview tiles
- utility tiles such as the workspace files view

Some tiles are file-backed and some are derived.

### File-Backed Tiles

Examples:
- `report.md`
- `data.csv`
- `chart.html`
- `notes.pdf`
- `figure.png`

These should support actions like:
- `Go to Tile`
- `Show in Workspace Files`
- `Download File`

### Derived Tiles

Examples:
- a chart built from a table
- cards built from search results
- inline markdown generated as a summary

These should support actions like:
- `Export Data`
- `Save Snapshot as PNG`

## Artifact Flow

The intended flow is:

1. The agent creates or updates files in the workspace.
2. The files appear in `Workspace Files`.
3. Files can be shown on the canvas as tiles.
4. The user can inspect, compare, group, or download them.

This is why a request like “make me a ZIP” is treated as file creation, not as a special tile export.

## Chat Model

There are two main chat modes:

- `Global chat`
  Works against the workspace generally.

- `Scoped chat`
  Works against the selected tile or selected tile group.

The main composer can inherit selected-tile scope. Contextual tile chat is still useful for tightly local reasoning.

## Interaction Model

### Canvas

| Action | Result |
|---|---|
| Drag background | Select tiles with a rectangle; hold Space or use the middle button to pan |
| Scroll / pinch | Zoom |
| Click tile | Select tile |
| Double-click tile | Ask a question about that tile |
| Shift-click | Multi-select |
| Select two tiles, then choose Associate | Persist an explicit association line |
| Select an association line | Select both endpoint tiles for inspection or disconnect |
| Drag tile header | Move tile |
| Drag a resize handle | Resize tile |
| Tile menu or selection toolbar | Open contextual chat for a tile or selection |
| Minimize | Send tile to dock |
| Maximize | Expand tile |

### Files

| Action | Result |
|---|---|
| Show on Canvas | Create or reveal a tile for that file |
| Go to Tile | Focus the existing tile |
| Download File | Download the durable artifact |
| Show in Workspace Files | Reveal the file in the shelf/context |

Contextual controls are screen-space UI. Zooming or resizing a tile changes
their position, not their size. File downloads keep their temporary Blob URL
alive long enough for the browser to begin the download before revoking it.

## Grouping and Connections

Tiles can be:
- grouped
- renamed as groups
- moved together
- queried as a group

Connections represent explicit provenance or follow-on relationships between tiles. They help explain how one tile led to another, but they are secondary to the file-first model. Agent-created derived tiles can request the same relationship with the exact source tile id; the UI tools persist that request together with the tile.

User-created associations are explicit workspace state. The canvas never draws a
new line merely because two tiles happen to be near each other or share a
source; select two tiles and choose Associate. Associations survive reload and
workspace export/import, and selecting a line reveals its endpoint tiles so the
same toolbar can disconnect it.

## Responsive Behavior

Wide screens:
- canvas and chat are visible together

Compact screens:
- canvas and chat switch via tabs
- the header compresses
- the files shelf remains accessible from the canvas view

The app should never rely on overlapping chat and canvas panes.

## Product Language

Use these terms consistently in user-facing copy:
- `tile`, not `panel`
- `file`, not `download`, for the artifact itself
- `Show on Canvas`, not `Open as Tile`
- `Go to Tile`, when a visible tile already exists

Internally, some state still uses `panels` in code and storage. That is an implementation detail, not product language.

## State Model

Conceptually, the canvas stores:

```ts
interface CanvasState {
  viewport: { x: number; y: number; zoom: number };
  tiles: TileState[];
  groups: TileGroup[];
  connections: TileConnection[];
}
```

In current persisted app state, this still maps onto `uiState.panels`, `groups`, and `connections`.

Persisted workspace state owns committed tile geometry, viewport, groups, and
associations. React Flow owns transient drag measurements and selection. Its
rendered nodes and edges are replaced only when those values changed; cloned
but equal streamed updates do not reseed them. This ownership boundary prevents
feedback loops and visible canvas vibration while preserving live agent
changes.

For a newly created workspace, the model replaces the placeholder with one
concise task-specific title. Once that title is established, later title edits
belong to the user in the workspace header. Files and surfaced tiles likewise
receive concise content-specific display titles rather than filenames or
generic labels.

## Design Principles

- spatial first
- files first
- truthful actions
- compact artifact surfacing
- strong desktop experience with usable compact layouts
- one coherent vocabulary

## Open Questions

- When should a generated result stay inline versus become a real file automatically?
- Which derived tiles should get first-class export actions beyond snapshots?
- How far should tile connections go visually before they add clutter?
- What is the right mobile floor for the canvas experience?
