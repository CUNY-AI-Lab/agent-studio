# Accessibility

Status: current behavior, testing, and limitations

This document covers the accessibility of the Agent Studio **canvas workspace**
frontend (`frontend/`), including keyboard operation, ARIA roles, live regions,
focus management, and current limitations.

## Canvas keyboard map

Tab into the canvas region, then Tab again to land on a tile. Exactly one tile
is in the tab order at a time (a roving tabindex), so the canvas takes a single
tab stop and the arrow keys drive geometry from the focused tile.

The same map is available in-app: press **`?`** while the canvas region is
focused, or use the **keyboard icon** in the workspace header. The in-app dialog renders
directly from the shared source `frontend/src/lib/keyboardMap.ts`; the tables
below are hand-maintained mirrors of that source, and a vitest drift check
(`keyboardMap.drift.test.ts`) fails the suite if they fall out of sync.

### Focus & selection

| Keys | Action |
| --- | --- |
| `Tab` / `Shift + Tab` | Move focus between tiles and controls |
| `Enter` / `Space` | Toggle selection of the focused tile (add modifier to multi-select) |
| `Escape` | Clear selection, close popover, or exit the maximized view |
| `Delete` / `Backspace` | Remove the selected tiles |

### Move & resize the focused tile

| Keys | Action |
| --- | --- |
| `Arrow keys` | Move the tile by 16px |
| `Shift + Arrow keys` | Move the tile by 64px |
| `Alt + Arrow keys` | Resize the tile by 16px (min 200×150) |
| `M` | Open the tile menu (`…`) |

### Groups & layout

| Keys | Action |
| --- | --- |
| `Enter` / `Space` (on a group boundary) | Select the group's tiles |
| `Arrow keys` (on a group boundary) | Move the whole group |
| `F2` (on a group boundary) | Rename the group |
| `Cmd / Ctrl + G` | Group the selected tiles |
| `Cmd / Ctrl + Shift + G` | Ungroup the selected group |

### Canvas view (when the canvas region itself is focused)

| Keys | Action |
| --- | --- |
| `+` / `=` | Zoom in |
| `-` / `_` | Zoom out |
| `0` | Reset zoom and position |
| `?` | Open the keyboard-shortcuts dialog |
| `Space + drag` | Pan the canvas (mouse) |

Every drag interaction on the canvas has a keyboard equivalent: tiles move and
resize with arrows, groups move with arrows, selection toggles with Enter/Space,
and the tile menu opens with `M`. All keyboard geometry changes go through the
**same** `onLayoutChange` / `onDragEnd` callbacks the mouse path uses, so layout
persists identically.

The shared keyboard-map label for Tab is broader than the current roving-focus
implementation. Tab reaches the canvas region and its one active tile, then
moves to the next page control; it does not rove among every tile.

## ARIA role decisions

- **Canvas = labeled `region`, not `application`.** We deliberately did *not*
  use `role="application"`. The canvas adds only a few affordances when the
  region itself is focused (zoom keys, `?`); it never swallows all keystrokes.
  Tiles use a roving tabindex so standard browse-mode navigation still works and
  a screen reader can read tile labels normally. `application` would have
  suppressed browse mode for no benefit.
- **Tiles = `role="group"`** with `aria-label` "`{title} ({type} tile)`" and
  `aria-pressed` reflecting selection. A group is the right container role for a
  labeled region that holds arbitrary artifact content and is itself
  interactive via a documented key set.
- **Group boundaries = `role="group"`**, focusable, labeled by the group name,
  `aria-pressed` for the active state.
- **Tile menu = `button` (with `aria-haspopup="menu"` / `aria-expanded`) opening
  a `role="menu"` with `role="menuitem"` items.** Simpler correct disclosure
  semantics than a full menubar.
- **Selection toolbar = `role="toolbar"`** with a descriptive label; every
  icon-only button carries an `aria-label` and its icon is `aria-hidden`.
  Dropdown triggers use `aria-haspopup`/`aria-expanded` and open `role="menu"`.
- **Dialogs** (`PublishDialog`, `MaximizedPanelOverlay`, `KeyboardShortcutsDialog`)
  = `role="dialog"` + `aria-modal="true"`, labeled, **focus-trapped**, Escape to
  close, focus restored to the opener on close. The trap is a hand-rolled util
  (`frontend/src/lib/focusTrap.ts`) — no new runtime dependency.
- **Contextual chat popover = `role="dialog"`** (non-modal) with a label; it
  already managed its own focus and Escape.
- **Landmarks:** header is `<header>` (banner), the canvas column is `<main>`,
  the chat panel is `<aside>` (complementary) with a label, and the files shelf
  is a labeled `<section>` whose files render as a `<ul>`/`<li>` list.

## Live regions

- **Toasts** (`WorkspaceToast`) are `role="status"` / `aria-live="polite"`.
- A dedicated **polite announcer** in `WorkspaceShell` speaks agent streaming
  status ("Agent is thinking…", "Agent response ready."), chat/rate-limit/API
  **errors**, and upload/file-change summaries — so they reach screen readers,
  not just the eyes. Repeated identical messages are re-announced by clearing
  the region first.
- The **chat status pill** is a labeled `role="status"` live region.
- The **contextual popover loading indicator** is a `role="status"` region;
  its animated dots are `aria-hidden`.
- The **zoom percentage** is `aria-live="polite"` so keyboard zoom is announced.

## Focus visibility & motion

- All interactive controls have theme-aware `:focus-visible` rings (Tailwind
  `focus-visible:ring-ring`, tuned for the dark theme). Focused tiles get a
  dedicated ring in `index.css` and reveal their resize handles.
- A **skip-to-canvas** link is the first focusable element; it focuses the
  canvas region directly.
- **`prefers-reduced-motion: reduce`** is honored globally in `index.css`:
  panel pop/slide/line-draw/toast animations and canvas position transitions
  collapse to instant.

## Forms & controls

Every input is labeled: the chat composer, workspace title/description, the
model `select`, the upload `input`, the group-rename input, and the publish
dialog fields. Icon-only buttons have `aria-label`s and their icons are
`aria-hidden`.

## How to test

Automated (jsdom + Testing Library, behavioral — no ARIA-tree snapshots):

```bash
bun run test:frontend        # includes the a11y suites below
bun run --cwd frontend typecheck
bun run --cwd frontend build
```

Key a11y test files:

- `frontend/src/lib/focusTrap.test.ts` — trap wrap/restore/Escape
- `frontend/src/components/canvas/DraggablePanel.test.tsx` — arrow-move delta,
  Shift/Alt variants, Enter/Space select, `M` menu, roles
- `frontend/src/components/canvas/GroupBoundary.test.tsx` — group keyboard move/select/rename
- `frontend/src/components/canvas/SelectionToolbar.test.tsx` — accessible names, menu semantics
- `frontend/src/components/workspace/KeyboardShortcutsDialog.test.tsx` — dialog + trap + Escape
- `frontend/src/components/workspace/PublishDialog.test.tsx` — dialog + trap + Escape
- `frontend/src/components/workspace/WorkspaceToast.test.tsx` — status live region

Manual (keyboard only): boot `bun run dev`, open a workspace, and Tab from the
top — you should reach the skip link, header controls, files, then the canvas
and a tile. Arrow-move the tile, press `M` for its menu, `?` for the shortcut
sheet, and confirm dialogs trap focus and restore it on Escape.

## Current limitations

- **No keyboard focus roving between tiles.** Arrows move the *focused* tile's
  geometry; a different tile currently becomes the roving target through
  pointer/selection flows. A future pass could add
  a 2-D spatial roving scheme (arrows change focus when a modifier is held, or a
  dedicated "navigate mode"), but that risks colliding with the move bindings.
- **Keyboard marquee selection is not implemented;**
  multi-select is Enter/Space per tile plus `Cmd/Ctrl` grouping.
- **Connection lines** (`ConnectionLines`) are decorative SVG and are not
  individually focusable/announced.
- **HomePage / ReadOnlyCanvas gallery view** has less complete semantic and
  keyboard coverage than the workspace canvas.
- The **selection toolbar** is not reachable by Tab from a tile in all cases
  because it is positioned/hover-driven; its actions are also available from the
  tile menu (`M`) and header, which are keyboard-reachable.
