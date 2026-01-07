---
name: threejs
description: Create interactive 3D visualizations using Three.js. Render 3D scenes, models, animations in preview panels. Use for data visualization, scientific models, architectural views, product displays. Example queries: 'create a 3D bar chart', 'visualize this data in 3D', 'show a rotating cube'. No auth required.
---

# Three.js 3D Visualization

## Overview
Create interactive 3D visualizations using Three.js library. Renders in preview panels with full mouse controls (orbit, zoom, pan).

## Basic Template

All Three.js visualizations use `addPanel({ type: 'preview', content: html })` with ES modules:

```javascript
const html = `<!DOCTYPE html>
<html>
<head>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { overflow: hidden; background: #1a1a1a; }
    canvas { display: block; }
  </style>
</head>
<body>
  <script type="importmap">
  {
    "imports": {
      "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
      "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
    }
  }
  </script>
  <script type="module">
    import * as THREE from 'three';
    import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

    // Scene setup
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a1a);

    // Camera
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(5, 5, 5);
    camera.lookAt(0, 0, 0);

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    document.body.appendChild(renderer.domElement);

    // Orbit controls (mouse interaction)
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(10, 10, 5);
    scene.add(directionalLight);

    // === YOUR 3D CONTENT HERE ===
    const geometry = new THREE.BoxGeometry(2, 2, 2);
    const material = new THREE.MeshStandardMaterial({ color: 0x6366f1 });
    const cube = new THREE.Mesh(geometry, material);
    scene.add(cube);

    // Grid helper (optional)
    const gridHelper = new THREE.GridHelper(10, 10, 0x444444, 0x222222);
    scene.add(gridHelper);

    // Animation loop
    function animate() {
      requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    }
    animate();

    // Handle resize
    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });
  </script>
</body>
</html>`;

await addPanel({ id: '3d-scene', type: 'preview', title: '3D Scene', content: html });
return 'Created 3D scene';
```

## 3D Bar Chart

```javascript
const data = [
  { label: '2020', value: 45 },
  { label: '2021', value: 72 },
  { label: '2022', value: 58 },
  { label: '2023', value: 91 },
  { label: '2024', value: 83 }
];

const maxValue = Math.max(...data.map(d => d.value));
const colors = ['#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899'];

const html = \`<!DOCTYPE html>
<html>
<head>
  <style>
    * { margin: 0; padding: 0; }
    body { overflow: hidden; background: #1a1a1a; font-family: system-ui; }
    #tooltip {
      position: fixed; padding: 8px 12px; background: rgba(0,0,0,0.8);
      color: white; border-radius: 6px; font-size: 14px; pointer-events: none;
      display: none; z-index: 100;
    }
  </style>
</head>
<body>
  <div id="tooltip"></div>
  <script type="importmap">
  {
    "imports": {
      "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
      "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
    }
  }
  </script>
  <script type="module">
    import * as THREE from 'three';
    import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

    const data = \${JSON.stringify(data)};
    const maxValue = \${maxValue};
    const colors = \${JSON.stringify(colors)};

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a1a);

    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(8, 6, 8);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    // Lighting
    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const light = new THREE.DirectionalLight(0xffffff, 0.8);
    light.position.set(10, 10, 5);
    scene.add(light);

    // Grid
    scene.add(new THREE.GridHelper(12, 12, 0x444444, 0x222222));

    // Bars
    const barWidth = 1.2;
    const spacing = 2;
    const startX = -((data.length - 1) * spacing) / 2;
    const bars = [];

    data.forEach((d, i) => {
      const height = (d.value / maxValue) * 5;
      const geometry = new THREE.BoxGeometry(barWidth, height, barWidth);
      const material = new THREE.MeshStandardMaterial({
        color: colors[i % colors.length],
        metalness: 0.3,
        roughness: 0.7
      });
      const bar = new THREE.Mesh(geometry, material);
      bar.position.set(startX + i * spacing, height / 2, 0);
      bar.userData = { label: d.label, value: d.value };
      scene.add(bar);
      bars.push(bar);
    });

    // Raycaster for hover
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    const tooltip = document.getElementById('tooltip');

    window.addEventListener('mousemove', (e) => {
      mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects(bars);

      if (intersects.length > 0) {
        const data = intersects[0].object.userData;
        tooltip.style.display = 'block';
        tooltip.style.left = e.clientX + 15 + 'px';
        tooltip.style.top = e.clientY + 15 + 'px';
        tooltip.textContent = data.label + ': ' + data.value;
      } else {
        tooltip.style.display = 'none';
      }
    });

    function animate() {
      requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    }
    animate();

    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });
  </script>
</body>
</html>\`;

await addPanel({ id: '3d-chart', type: 'preview', title: '3D Bar Chart', content: html });
return 'Created 3D bar chart';
```

## 3D Scatter Plot

```javascript
const points = [
  { x: 1, y: 2, z: 3, label: 'A' },
  { x: -2, y: 1, z: 2, label: 'B' },
  { x: 3, y: -1, z: -2, label: 'C' },
  // ... more points
];

const html = \`<!DOCTYPE html>
<html>
<head>
  <style>
    * { margin: 0; padding: 0; }
    body { overflow: hidden; background: #0a0a0a; }
  </style>
</head>
<body>
  <script type="importmap">
  {
    "imports": {
      "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
      "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
    }
  }
  </script>
  <script type="module">
    import * as THREE from 'three';
    import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

    const points = \${JSON.stringify(points)};

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0a);

    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(10, 10, 10);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const light = new THREE.PointLight(0xffffff, 1);
    light.position.set(10, 10, 10);
    scene.add(light);

    // Axes
    scene.add(new THREE.AxesHelper(5));

    // Points
    const geometry = new THREE.SphereGeometry(0.2, 16, 16);
    const material = new THREE.MeshStandardMaterial({
      color: 0x6366f1,
      emissive: 0x6366f1,
      emissiveIntensity: 0.2
    });

    points.forEach(p => {
      const sphere = new THREE.Mesh(geometry, material);
      sphere.position.set(p.x, p.y, p.z);
      scene.add(sphere);
    });

    function animate() {
      requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    }
    animate();

    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });
  </script>
</body>
</html>\`;

await addPanel({ id: '3d-scatter', type: 'preview', title: '3D Scatter Plot', content: html });
```

## Animated Globe

```javascript
const html = \`<!DOCTYPE html>
<html>
<head>
  <style>
    * { margin: 0; padding: 0; }
    body { overflow: hidden; background: #000; }
  </style>
</head>
<body>
  <script type="importmap">
  {
    "imports": {
      "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
      "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
    }
  }
  </script>
  <script type="module">
    import * as THREE from 'three';
    import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);

    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 3;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.5;

    // Globe
    const geometry = new THREE.SphereGeometry(1, 64, 64);
    const material = new THREE.MeshStandardMaterial({
      color: 0x1e40af,
      metalness: 0.3,
      roughness: 0.7,
      wireframe: false
    });
    const globe = new THREE.Mesh(geometry, material);
    scene.add(globe);

    // Wireframe overlay
    const wireGeometry = new THREE.SphereGeometry(1.01, 32, 32);
    const wireMaterial = new THREE.MeshBasicMaterial({
      color: 0x3b82f6,
      wireframe: true,
      transparent: true,
      opacity: 0.3
    });
    const wireGlobe = new THREE.Mesh(wireGeometry, wireMaterial);
    scene.add(wireGlobe);

    // Lighting
    scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    const light = new THREE.PointLight(0xffffff, 1.5);
    light.position.set(5, 3, 5);
    scene.add(light);

    // Stars
    const starsGeometry = new THREE.BufferGeometry();
    const starPositions = [];
    for (let i = 0; i < 1000; i++) {
      starPositions.push(
        (Math.random() - 0.5) * 100,
        (Math.random() - 0.5) * 100,
        (Math.random() - 0.5) * 100
      );
    }
    starsGeometry.setAttribute('position', new THREE.Float32BufferAttribute(starPositions, 3));
    const starsMaterial = new THREE.PointsMaterial({ color: 0xffffff, size: 0.1 });
    scene.add(new THREE.Points(starsGeometry, starsMaterial));

    function animate() {
      requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    }
    animate();

    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });
  </script>
</body>
</html>\`;

await addPanel({ id: '3d-globe', type: 'preview', title: 'Globe', content: html });
```

## 3D Text

```javascript
const html = \`<!DOCTYPE html>
<html>
<head>
  <style>
    * { margin: 0; padding: 0; }
    body { overflow: hidden; background: #1a1a1a; }
  </style>
</head>
<body>
  <script type="importmap">
  {
    "imports": {
      "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
      "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
    }
  }
  </script>
  <script type="module">
    import * as THREE from 'three';
    import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
    import { FontLoader } from 'three/addons/loaders/FontLoader.js';
    import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a1a);

    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 0, 10);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const light = new THREE.DirectionalLight(0xffffff, 1);
    light.position.set(5, 5, 5);
    scene.add(light);

    // Load font and create text
    const loader = new FontLoader();
    loader.load('https://threejs.org/examples/fonts/helvetiker_bold.typeface.json', (font) => {
      const textGeometry = new TextGeometry('Hello 3D!', {
        font: font,
        size: 1,
        height: 0.3,
        curveSegments: 12,
        bevelEnabled: true,
        bevelThickness: 0.03,
        bevelSize: 0.02,
        bevelSegments: 5
      });
      textGeometry.center();

      const material = new THREE.MeshStandardMaterial({
        color: 0x6366f1,
        metalness: 0.3,
        roughness: 0.4
      });
      const textMesh = new THREE.Mesh(textGeometry, material);
      scene.add(textMesh);
    });

    function animate() {
      requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    }
    animate();

    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });
  </script>
</body>
</html>\`;

await addPanel({ id: '3d-text', type: 'preview', title: '3D Text', content: html });
```

## Common Geometries

```javascript
// Box
new THREE.BoxGeometry(width, height, depth);

// Sphere
new THREE.SphereGeometry(radius, widthSegments, heightSegments);

// Cylinder
new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments);

// Cone
new THREE.ConeGeometry(radius, height, segments);

// Torus (donut)
new THREE.TorusGeometry(radius, tube, radialSegments, tubularSegments);

// Plane
new THREE.PlaneGeometry(width, height);

// Ring
new THREE.RingGeometry(innerRadius, outerRadius, segments);
```

## Materials

```javascript
// Basic (unlit, solid color)
new THREE.MeshBasicMaterial({ color: 0xff0000 });

// Standard (PBR, responds to light)
new THREE.MeshStandardMaterial({
  color: 0x6366f1,
  metalness: 0.5,
  roughness: 0.5
});

// Phong (shiny)
new THREE.MeshPhongMaterial({
  color: 0x00ff00,
  shininess: 100
});

// Wireframe
new THREE.MeshBasicMaterial({ wireframe: true, color: 0xffffff });

// Transparent
new THREE.MeshStandardMaterial({
  color: 0x0000ff,
  transparent: true,
  opacity: 0.5
});
```

## Tips
- Always include OrbitControls for mouse interaction
- Use `MeshStandardMaterial` with lighting for realistic looks
- Add `GridHelper` or `AxesHelper` for orientation
- Use `raycaster` for hover/click interactions
- Panel maximize (menu -> Maximize) works great for 3D views
- Combine with data from APIs to create data visualizations
