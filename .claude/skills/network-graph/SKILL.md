---
name: network-graph
description: Create interactive network/graph visualizations using D3 force simulation. Show relationships, connections, hierarchies. Nodes and links with physics-based layout. Example queries: 'visualize citation network', 'show author collaborations', 'create a knowledge graph'. No auth required.
---

# Network Graph Visualization

## Overview
Create interactive force-directed network graphs using D3.js. Great for visualizing relationships, citations, collaborations, and hierarchical data.

## Basic Network Graph

```javascript
const nodes = [
  { id: 'A', label: 'Node A', group: 1 },
  { id: 'B', label: 'Node B', group: 1 },
  { id: 'C', label: 'Node C', group: 2 },
  { id: 'D', label: 'Node D', group: 2 },
];

const links = [
  { source: 'A', target: 'B' },
  { source: 'A', target: 'C' },
  { source: 'B', target: 'D' },
  { source: 'C', target: 'D' },
];

const html = \`<!DOCTYPE html>
<html>
<head>
  <style>
    * { margin: 0; padding: 0; }
    body { background: #1a1a1a; overflow: hidden; }
    svg { display: block; }
    .node { cursor: pointer; }
    .node circle { stroke: #fff; stroke-width: 2px; }
    .node text { fill: #fff; font: 12px system-ui; pointer-events: none; }
    .link { stroke: #666; stroke-opacity: 0.6; }
    #tooltip {
      position: fixed; padding: 8px 12px; background: rgba(0,0,0,0.9);
      color: #fff; border-radius: 6px; font: 13px system-ui;
      pointer-events: none; display: none; z-index: 100;
    }
  </style>
</head>
<body>
  <div id="tooltip"></div>
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <script>
    const nodes = \${JSON.stringify(nodes)};
    const links = \${JSON.stringify(links)};

    const width = window.innerWidth;
    const height = window.innerHeight;

    const color = d3.scaleOrdinal(d3.schemeCategory10);

    const svg = d3.select('body').append('svg')
      .attr('width', width)
      .attr('height', height);

    // Zoom behavior
    const g = svg.append('g');
    svg.call(d3.zoom()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => g.attr('transform', event.transform)));

    const simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id(d => d.id).distance(100))
      .force('charge', d3.forceManyBody().strength(-300))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius(30));

    const link = g.append('g')
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('class', 'link')
      .attr('stroke-width', 2);

    const node = g.append('g')
      .selectAll('g')
      .data(nodes)
      .join('g')
      .attr('class', 'node')
      .call(d3.drag()
        .on('start', dragstarted)
        .on('drag', dragged)
        .on('end', dragended));

    node.append('circle')
      .attr('r', 20)
      .attr('fill', d => color(d.group));

    node.append('text')
      .attr('dy', 4)
      .attr('text-anchor', 'middle')
      .text(d => d.label || d.id);

    // Tooltip
    const tooltip = d3.select('#tooltip');
    node.on('mouseover', (event, d) => {
      tooltip.style('display', 'block')
        .style('left', (event.pageX + 10) + 'px')
        .style('top', (event.pageY + 10) + 'px')
        .html(d.label || d.id);
    }).on('mouseout', () => tooltip.style('display', 'none'));

    simulation.on('tick', () => {
      link
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x)
        .attr('y2', d => d.target.y);
      node.attr('transform', d => \\\`translate(\\\${d.x},\\\${d.y})\\\`);
    });

    function dragstarted(event) {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      event.subject.fx = event.subject.x;
      event.subject.fy = event.subject.y;
    }

    function dragged(event) {
      event.subject.fx = event.x;
      event.subject.fy = event.y;
    }

    function dragended(event) {
      if (!event.active) simulation.alphaTarget(0);
      event.subject.fx = null;
      event.subject.fy = null;
    }

    window.addEventListener('resize', () => {
      svg.attr('width', window.innerWidth).attr('height', window.innerHeight);
      simulation.force('center', d3.forceCenter(window.innerWidth / 2, window.innerHeight / 2));
      simulation.alpha(0.3).restart();
    });
  </script>
</body>
</html>\`;

await addPanel({ id: 'network', type: 'preview', title: 'Network Graph', content: html });
```

## Citation Network Example

```javascript
// Papers with their citations
const papers = [
  { id: 'p1', title: 'Attention Is All You Need', year: 2017, citations: 50000 },
  { id: 'p2', title: 'BERT', year: 2018, citations: 40000 },
  { id: 'p3', title: 'GPT-3', year: 2020, citations: 10000 },
  { id: 'p4', title: 'Vision Transformer', year: 2020, citations: 8000 },
];

const citations = [
  { source: 'p2', target: 'p1' },  // BERT cites Attention
  { source: 'p3', target: 'p1' },  // GPT-3 cites Attention
  { source: 'p3', target: 'p2' },  // GPT-3 cites BERT
  { source: 'p4', target: 'p1' },  // ViT cites Attention
];

// Convert to graph format with sizing based on citations
const maxCitations = Math.max(...papers.map(p => p.citations));
const nodes = papers.map(p => ({
  id: p.id,
  label: p.title.length > 20 ? p.title.slice(0, 20) + '...' : p.title,
  fullTitle: p.title,
  year: p.year,
  citations: p.citations,
  radius: 15 + (p.citations / maxCitations) * 25,
  group: p.year
}));

const links = citations.map(c => ({
  source: c.source,
  target: c.target
}));

// Then use the template above with these nodes/links
```

## Hierarchical/Tree Layout

```javascript
const data = {
  name: 'Root',
  children: [
    {
      name: 'Branch 1',
      children: [
        { name: 'Leaf 1.1' },
        { name: 'Leaf 1.2' }
      ]
    },
    {
      name: 'Branch 2',
      children: [
        { name: 'Leaf 2.1' }
      ]
    }
  ]
};

const html = \`<!DOCTYPE html>
<html>
<head>
  <style>
    * { margin: 0; padding: 0; }
    body { background: #1a1a1a; overflow: hidden; }
    .node circle { fill: #6366f1; stroke: #fff; stroke-width: 2px; }
    .node text { fill: #fff; font: 12px system-ui; }
    .link { fill: none; stroke: #666; stroke-width: 2px; }
  </style>
</head>
<body>
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <script>
    const data = \${JSON.stringify(data)};

    const width = window.innerWidth;
    const height = window.innerHeight;
    const margin = { top: 40, right: 40, bottom: 40, left: 40 };

    const svg = d3.select('body').append('svg')
      .attr('width', width)
      .attr('height', height);

    const g = svg.append('g')
      .attr('transform', \\\`translate(\\\${margin.left},\\\${margin.top})\\\`);

    const root = d3.hierarchy(data);
    const treeLayout = d3.tree().size([width - margin.left - margin.right, height - margin.top - margin.bottom]);
    treeLayout(root);

    // Links
    g.selectAll('.link')
      .data(root.links())
      .join('path')
      .attr('class', 'link')
      .attr('d', d3.linkVertical()
        .x(d => d.x)
        .y(d => d.y));

    // Nodes
    const node = g.selectAll('.node')
      .data(root.descendants())
      .join('g')
      .attr('class', 'node')
      .attr('transform', d => \\\`translate(\\\${d.x},\\\${d.y})\\\`);

    node.append('circle').attr('r', 8);
    node.append('text')
      .attr('dy', -15)
      .attr('text-anchor', 'middle')
      .text(d => d.data.name);
  </script>
</body>
</html>\`;

await addPanel({ id: 'tree', type: 'preview', title: 'Tree', content: html });
```

## Customization Options

### Node Styling
```javascript
// Size by value
node.append('circle')
  .attr('r', d => d.radius || 10)
  .attr('fill', d => color(d.group));

// With images
node.append('image')
  .attr('xlink:href', d => d.image)
  .attr('x', -20).attr('y', -20)
  .attr('width', 40).attr('height', 40);
```

### Link Styling
```javascript
// Curved links
.attr('d', d => {
  const dx = d.target.x - d.source.x;
  const dy = d.target.y - d.source.y;
  const dr = Math.sqrt(dx * dx + dy * dy);
  return \`M\${d.source.x},\${d.source.y}A\${dr},\${dr} 0 0,1 \${d.target.x},\${d.target.y}\`;
});

// Arrows
svg.append('defs').append('marker')
  .attr('id', 'arrow')
  .attr('viewBox', '0 -5 10 10')
  .attr('refX', 25)
  .attr('refY', 0)
  .attr('markerWidth', 6)
  .attr('markerHeight', 6)
  .attr('orient', 'auto')
  .append('path')
  .attr('d', 'M0,-5L10,0L0,5')
  .attr('fill', '#666');

link.attr('marker-end', 'url(#arrow)');
```

### Force Parameters
```javascript
// Adjust spacing
.force('charge', d3.forceManyBody().strength(-500))  // More negative = more spread
.force('link', d3.forceLink(links).distance(150))     // Link length
.force('collision', d3.forceCollide().radius(40))     // Node collision radius
```

## Use Cases
- Citation networks (papers referencing papers)
- Author collaboration graphs
- Knowledge graphs / concept maps
- Organizational hierarchies
- Social network analysis
- Dependency graphs (packages, modules)

## Tips
- Use `d.group` for coloring related nodes
- Scale node size by importance (citations, connections)
- Add tooltips for detailed info on hover
- Use zoom for large networks
- Consider filtering to top N nodes for readability
