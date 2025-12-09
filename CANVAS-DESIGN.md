# Agent Studio Canvas Redesign

## Vision

Transform Agent Studio from a rigid panel system into a **spatial workspace** where AI-created artifacts live on a canvas that users can explore, arrange, and iterate on.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Agent Studio                                              [zoom] [fit] [?] │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│    ┌─────────────┐                                                          │
│    │ 📊 Sales    │     ┌─────────────────────┐                              │
│    │   Table     │     │  📈 Revenue Chart   │                              │
│    │  [12 rows]  │────▶│   (linked)          │                              │
│    └─────────────┘     └─────────────────────┘                              │
│                                                                             │
│                              ┌─────────────┐                                │
│         ┌───────────────────▶│ 📝 Summary  │                                │
│         │                    │   Markdown  │                                │
│         │                    └─────────────┘                                │
│    ┌────┴────────┐                                                          │
│    │ 🃏 Top      │                                                          │
│    │  Products   │                                       ┌────────────────┐ │
│    │   Cards     │                                       │ 💬 Chat        │ │
│    └─────────────┘                                       │                │ │
│                                                          │ Agent is       │ │
│    ═══════════════════════════════════════════          │ creating...    │ │
│    · · · · · · · · · · · · · · · · · · · · · ·          │                │ │
│    (infinite canvas - pan & zoom)                        │ [────────────] │ │
│                                                          └────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Core Concepts

### 1. The Canvas
- **Infinite 2D space** - pan with drag, zoom with scroll/pinch
- **Grid snapping** (optional) - helps alignment without forcing it
- **Dot pattern background** - subtle depth, shows you're in a space
- **Minimap** (optional) - for orientation when zoomed in

### 2. Artifacts (Nodes)
Each artifact the agent creates becomes a **node** on the canvas:

```
┌──────────────────────────────────┐
│ ◉ Sales Data              ⋮  ×  │  ← Header: icon, title, menu, close
├──────────────────────────────────┤
│                                  │
│     [Artifact Content]           │  ← Body: table/chart/cards/markdown
│                                  │
├──────────────────────────────────┤
│ table · 12 rows · 2s ago         │  ← Footer: type, meta, timestamp
└──────────────────────────────────┘
     │
     └──○ (connection point)
```

**Artifact Types:**
- `table` - Data grid with sort/filter
- `chart` - Bar, line, pie, area (Recharts)
- `cards` - Card grid for items
- `markdown` - Rich text content
- `code` - Syntax-highlighted code block
- `image` - Generated or uploaded images
- `preview` - Live HTML preview (sandboxed)

### 3. Connections (Optional)
Visual lines showing data flow:
- Table → Chart (chart uses table data)
- Cards → Detail (click card shows detail)
- Dashed lines for "references"
- Solid lines for "data flow"

### 4. The Chat Panel
**Floating sidebar** - not part of the canvas:

```
┌────────────────────┐
│ 💬 Conversation    │  ← Collapsible
├────────────────────┤
│                    │
│ You: Create a      │
│ sales dashboard    │
│                    │
│ Agent: I'll...     │
│ ┌────┐ ┌────┐      │  ← Tool cards (compact)
│ │exec│ │set │      │
│ └────┘ └────┘      │
│                    │
│ Created 3 artifacts│
│                    │
├────────────────────┤
│ [Type message...]  │
└────────────────────┘
```

**Behaviors:**
- Slides in from right (or left)
- Can be collapsed to icon-only
- Can be popped out as floating window
- Always accessible via keyboard shortcut

## Layout Modes

### Mode 1: Auto-Layout (Default)
Artifacts auto-arrange in a pleasant flow:
- New artifacts appear near the last one
- Smart spacing based on artifact size
- No overlaps
- User can still drag to reposition

### Mode 2: Free Canvas
Full spatial freedom:
- Drag anywhere
- Manual sizing
- Overlaps allowed
- Connections visible

### Mode 3: Focus View
Single artifact expanded:
- Click artifact to focus
- Others fade/minimize
- Great for detailed work
- Escape to return

## Visual Design

### Aesthetic Direction: "Scholarly Glass"
Refined, editorial feel with modern glass-morphism:

**Colors:**
```css
--canvas-bg: oklch(0.96 0.01 250);      /* Cool paper */
--canvas-dots: oklch(0.85 0.02 250);    /* Subtle grid */
--artifact-bg: oklch(0.99 0.005 80);    /* Warm white */
--artifact-border: oklch(0.90 0.01 80); /* Soft edge */
--artifact-shadow: 0 8px 32px oklch(0.2 0.02 250 / 0.08);
--accent: oklch(0.65 0.15 45);          /* Warm amber */
--chat-bg: oklch(0.98 0.005 80 / 0.9);  /* Glass effect */
```

**Typography:**
- Artifact titles: Crimson Pro (serif, editorial)
- Content: DM Sans (clean, readable)
- Code/data: JetBrains Mono

**Effects:**
- Artifacts have subtle shadow + border
- Selected artifact has accent glow
- Hover shows resize handles
- Drag shows ghost + drop zone
- New artifacts fade-in with slight scale

### Artifact Card Design

```
┌─────────────────────────────────────────┐
│                                         │
│  ┌─────────────────────────────────┐    │
│  │ ▣ Sales Performance    ⋯  □  × │    │  ← Frosted header
│  ├─────────────────────────────────┤    │
│  │                                 │    │
│  │                                 │    │
│  │      [ Chart / Table /         │    │  ← Content area
│  │         Cards / etc ]          │    │
│  │                                 │    │
│  │                                 │    │
│  ├─────────────────────────────────┤    │
│  │ 📊 chart · bar · 3s ago        │    │  ← Subtle footer
│  └─────────────────────────────────┘    │
│     ↖ subtle outer glow when selected   │
└─────────────────────────────────────────┘
```

## Interaction Model

### Canvas Interactions
| Action | Result |
|--------|--------|
| Drag background | Pan canvas |
| Scroll / Pinch | Zoom in/out |
| Double-click background | Create note? Or just zoom to fit |
| `Space` + drag | Pan (Figma-style) |
| `Cmd/Ctrl` + `0` | Zoom to fit all |
| `Cmd/Ctrl` + `1` | Zoom to 100% |

### Artifact Interactions
| Action | Result |
|--------|--------|
| Click | Select |
| Double-click | Focus mode (expand) |
| Drag | Move |
| Drag edge | Resize |
| Right-click | Context menu |
| `Delete` / `Backspace` | Remove (with confirm) |
| `Cmd/Ctrl` + `D` | Duplicate |

### Chat Interactions
| Action | Result |
|--------|--------|
| `Cmd/Ctrl` + `K` | Focus chat input |
| `Cmd/Ctrl` + `\` | Toggle chat panel |
| `Escape` | Close chat / deselect |

## State Management

### Canvas State (stored per workspace)
```typescript
interface CanvasState {
  viewport: {
    x: number;      // Pan offset
    y: number;
    zoom: number;   // 0.25 to 2.0
  };
  nodes: CanvasNode[];
  connections: Connection[];
  selectedNodeId: string | null;
}

interface CanvasNode {
  id: string;
  type: 'table' | 'chart' | 'cards' | 'markdown' | 'code' | 'preview';
  position: { x: number; y: number };
  size: { width: number; height: number };
  dataId: string;  // Reference to actual data (tableId, chartId, etc.)
  zIndex: number;
}

interface Connection {
  id: string;
  from: string;    // Node ID
  to: string;      // Node ID
  type: 'data' | 'reference';
}
```

### Migration from Current System
Current `UIState.panels[]` becomes `CanvasState.nodes[]`:
- `panel.type` → `node.type`
- `panel.tableId` → `node.dataId`
- New: position, size, zIndex

## Implementation Phases

### Phase 1: Basic Canvas
- [ ] Canvas component with pan/zoom
- [ ] Render artifacts as positioned nodes
- [ ] Drag to reposition
- [ ] Chat as floating sidebar
- [ ] Auto-layout for new artifacts

### Phase 2: Polish
- [ ] Resize handles
- [ ] Focus mode (double-click)
- [ ] Minimap
- [ ] Keyboard shortcuts
- [ ] Connection lines

### Phase 3: Advanced
- [ ] Multi-select
- [ ] Copy/paste artifacts
- [ ] Export canvas as image
- [ ] Templates / saved layouts
- [ ] Collaborative cursors (future)

## Technical Approach

### Option A: Pure CSS/DOM
- Use CSS transforms for pan/zoom
- Positioned divs for nodes
- Pros: Simple, accessible, SEO-friendly
- Cons: Performance at scale, complex gestures

### Option B: React Flow / Similar Library
- Battle-tested canvas infrastructure
- Built-in pan/zoom, connections, minimap
- Pros: Fast to implement, handles edge cases
- Cons: Dependency, styling constraints

### Option C: Custom Canvas (HTML Canvas / SVG)
- Full control
- Best performance
- Pros: Unlimited flexibility
- Cons: Most work, accessibility challenges

**Recommendation:** Start with **Option A** (pure CSS/DOM) for simplicity, with architecture that could adopt React Flow later if needed.

## Questions to Resolve

1. **Auto-layout algorithm** - How should new artifacts be positioned?
   - Grid-based? Flow-based? Force-directed?

2. **Connections** - Are they necessary for v1, or a nice-to-have?

3. **Mobile** - Canvas on mobile is tricky. Fallback to stacked view?

4. **Persistence** - Save node positions to server, or just session?

5. **Chat position** - Fixed right sidebar, or floating/movable?

---

## Inspiration

- [Figma](https://figma.com) - The gold standard for canvas UX
- [Miro](https://miro.com) - Collaborative infinite canvas
- [tldraw](https://tldraw.com) - Simple, delightful whiteboard
- [Obsidian Canvas](https://obsidian.md) - Note cards on canvas
- [Apple Freeform](https://apple.com/freeform) - Native feel, gesture-first
- [Hatch Canvas](https://hatch.ai) - AI + visual workspace fusion
- [Jeda.ai](https://jeda.ai) - "Think visually on infinite canvas"
