# Frontend Design

Guidelines for creating distinctive, production-grade frontend interfaces that avoid generic "AI slop" aesthetics. Use this skill ALWAYS when creating UI with `addPanel({ type: 'preview', content: html })`.

## Design Thinking

Before coding, commit to a BOLD aesthetic direction:

- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Pick an extreme: brutally minimal, maximalist chaos, retro-futuristic, organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric, soft/pastel, industrial/utilitarian, etc.
- **Differentiation**: What makes this UNFORGETTABLE? What's the one thing someone will remember?

**CRITICAL**: Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work - the key is intentionality, not intensity.

## Implementation

Create complete HTML with embedded CSS and JavaScript:

```javascript
await addPanel({
  id: 'my-app',
  type: 'preview',
  title: 'My App',
  content: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>App</title>
  <style>
    /* Your CSS here */
  </style>
</head>
<body>
  <!-- Your HTML here -->
  <script>
    // Your JavaScript here
  </script>
</body>
</html>`
});
```

## Frontend Aesthetics Guidelines

### Typography

- Choose fonts that are beautiful, unique, and interesting
- NEVER use generic fonts: Inter, Arial, Roboto, system fonts
- Use Google Fonts for distinctive choices that elevate the aesthetic
- Pair a distinctive display font with a refined body font

```html
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300..700&family=Instrument+Serif&display=swap" rel="stylesheet">
```

### Color & Theme

- Commit to a cohesive aesthetic with CSS variables
- Dominant colors with sharp accents outperform timid, evenly-distributed palettes
- NEVER use cliched purple gradients on white backgrounds

```css
:root {
  --bg-primary: #0a0a0a;
  --text-primary: #fafafa;
  --accent: #ff6b35;
}
```

### Motion

- Use CSS animations for effects and micro-interactions
- Focus on high-impact moments: page load with staggered reveals
- Use `animation-delay` for orchestrated sequences
- Scroll-triggering and hover states that surprise

```css
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: translateY(0); }
}

.card {
  animation: fadeUp 0.6s ease-out forwards;
  animation-delay: calc(var(--i) * 0.1s);
}
```

### Spatial Composition

- Unexpected layouts with asymmetry and overlap
- Grid-breaking elements
- Generous negative space OR controlled density
- Diagonal flow and unconventional positioning

### Backgrounds & Visual Details

Create atmosphere and depth:

- Gradient meshes and noise textures
- Geometric patterns and layered transparencies
- Dramatic shadows and decorative borders
- Grain overlays and custom cursors

```css
body {
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
}
```

## What to AVOID

NEVER use generic AI-generated aesthetics:

- Overused font families (Inter, Roboto, Arial, system fonts)
- Cliched color schemes (purple gradients on white)
- Predictable layouts and component patterns
- Cookie-cutter design lacking context-specific character
- Safe, boring, forgettable interfaces

## Remember

You are capable of extraordinary creative work. Don't hold back. Show what can truly be created when thinking outside the box and committing fully to a distinctive vision.

No two interfaces should look the same. Vary between light and dark themes, different fonts, different aesthetics. Each creation should be memorable and unique.
