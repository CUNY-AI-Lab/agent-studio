# Leaflet Maps

## Overview
Create interactive maps in preview panels using Leaflet.js. Load from CDN - no build step needed.

## Tile Providers

Choose based on aesthetic needs:

| Provider | URL | Style |
|----------|-----|-------|
| OpenStreetMap | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | Classic, detailed |
| CartoDB Light | `https://cartodb-basemaps-{s}.global.ssl.fastly.net/light_all/{z}/{x}/{y}.png` | Clean, minimal |
| CartoDB Dark | `https://cartodb-basemaps-{s}.global.ssl.fastly.net/dark_all/{z}/{x}/{y}.png` | Dark mode |
| CartoDB Voyager | `https://cartodb-basemaps-{s}.global.ssl.fastly.net/rastertiles/voyager/{z}/{x}/{y}.png` | Modern, colorful |

## CDN Links
```html
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
```

## Basic Map

```javascript
await addPanel({
  id: 'map',
  type: 'preview',
  title: 'Map',
  content: `<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    body { margin: 0; }
    #map { width: 100%; height: 100vh; }
  </style>
</head>
<body>
  <div id="map"></div>
  <script>
    const map = L.map('map').setView([40.7128, -74.0060], 13);

    // MUST use OpenStreetMap tiles - other providers have CORS issues
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors'
    }).addTo(map);
  </script>
</body>
</html>`
});
```

## Adding Markers

```javascript
// Single marker
L.marker([40.7128, -74.0060])
  .addTo(map)
  .bindPopup('<b>New York City</b><br>Population: 8.3M');

// Multiple markers from data
const locations = [
  { lat: 40.7128, lng: -74.0060, name: 'NYC' },
  { lat: 34.0522, lng: -118.2437, name: 'LA' }
];

locations.forEach(loc => {
  L.marker([loc.lat, loc.lng])
    .addTo(map)
    .bindPopup(loc.name);
});
```

## Marker Clusters (for many points)

```html
<link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.4.1/dist/MarkerCluster.css" />
<link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.4.1/dist/MarkerCluster.Default.css" />
<script src="https://unpkg.com/leaflet.markercluster@1.4.1/dist/leaflet.markercluster.js"></script>
```

```javascript
const markers = L.markerClusterGroup();
locations.forEach(loc => {
  markers.addLayer(L.marker([loc.lat, loc.lng]));
});
map.addLayer(markers);
```

## Custom Marker Icons

```javascript
const customIcon = L.icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34]
});

L.marker([lat, lng], { icon: customIcon }).addTo(map);
```

## Fit Bounds to Markers

```javascript
const group = L.featureGroup(markers);
map.fitBounds(group.getBounds().pad(0.1));
```

## Drawing Shapes

```javascript
// Circle
L.circle([lat, lng], {
  radius: 500,  // meters
  color: 'blue',
  fillOpacity: 0.3
}).addTo(map);

// Polygon
L.polygon([
  [lat1, lng1],
  [lat2, lng2],
  [lat3, lng3]
]).addTo(map);

// Polyline (path)
L.polyline([
  [lat1, lng1],
  [lat2, lng2]
], { color: 'red' }).addTo(map);
```

## GeoJSON

```javascript
const geojsonData = {
  "type": "FeatureCollection",
  "features": [...]
};

L.geoJSON(geojsonData, {
  onEachFeature: (feature, layer) => {
    layer.bindPopup(feature.properties.name);
  }
}).addTo(map);
```

## Common Coordinates

| Location | Lat, Lng |
|----------|----------|
| New York | 40.7128, -74.0060 |
| Los Angeles | 34.0522, -118.2437 |
| London | 51.5074, -0.1278 |
| Paris | 48.8566, 2.3522 |
| Tokyo | 35.6762, 139.6503 |

## Troubleshooting

**Tiles not loading?**
- Check the tile URL pattern is correct
- Verify the provider allows public access

**Map not showing?**
- Ensure the container has explicit height (`height: 100vh` or fixed pixels)
- Call `map.invalidateSize()` if container size changes
