---
name: nyc-opendata
description: Access NYC Open Data via Socrata API. Thousands of datasets on NYC demographics, transportation, housing, crime, 311 calls, permits, inspections, and more. Example queries: 'NYC restaurant inspections', '311 complaints by zip code', 'building permits in Brooklyn', 'subway ridership data'. No auth required.
---

# NYC Open Data (Socrata SODA API)

## Overview
Access thousands of NYC government datasets including demographics, transportation, housing, crime, health, permits, and more.
**No authentication required** for basic use (rate limited).

## Base URL
```
https://data.cityofnewyork.us/resource/{dataset-id}.json
```

## Finding Datasets

Browse datasets at: https://opendata.cityofnewyork.us/

Popular dataset IDs:
| Dataset | ID | Description |
|---------|-----|-------------|
| 311 Service Requests | `erm2-nwe9` | All 311 complaints |
| Restaurant Inspections | `43nn-pn8j` | Health inspection results |
| Building Permits | `ipu4-2vj7` | DOB permit issuances |
| NYPD Complaints | `qgea-i56i` | Crime complaints |
| Film Permits | `tg4x-b46p` | Movie/TV filming locations |
| WiFi Hotspots | `yjub-udmw` | Public WiFi locations |
| Dog Licenses | `nu7n-tubp` | Registered dogs |
| Parking Violations | `nc67-uf89` | Parking tickets |

## Query Parameters (SoQL)

- `$select` - Columns to return
- `$where` - Filter conditions (SQL-like)
- `$order` - Sort by column
- `$limit` - Max rows (default 1000, max 50000)
- `$offset` - Pagination offset
- `$q` - Full text search
- `$group` - Group by column
- `$having` - Filter after grouping

## Example Code

### Basic Query
```javascript
// Get recent 311 complaints
const url = 'https://data.cityofnewyork.us/resource/erm2-nwe9.json?$limit=100&$order=created_date DESC';
const res = await fetch(url);
const data = await res.json();

return data.map(row => ({
  date: row.created_date,
  type: row.complaint_type,
  descriptor: row.descriptor,
  borough: row.borough,
  address: row.incident_address
}));
```

### Filter by Condition
```javascript
// Restaurant inspections with critical violations in Manhattan
const where = encodeURIComponent("boro = 'MANHATTAN' AND critical_flag = 'Critical'");
const url = `https://data.cityofnewyork.us/resource/43nn-pn8j.json?$where=${where}&$limit=50`;

const res = await fetch(url);
const data = await res.json();

return data.map(row => ({
  name: row.dba,
  address: row.building + ' ' + row.street,
  violation: row.violation_description,
  date: row.inspection_date,
  score: row.score
}));
```

### Search by Text
```javascript
// Full text search in 311 data
const query = encodeURIComponent('noise complaint');
const url = `https://data.cityofnewyork.us/resource/erm2-nwe9.json?$q=${query}&$limit=50`;

const res = await fetch(url);
return await res.json();
```

### Aggregate Data
```javascript
// Count 311 complaints by borough
const url = 'https://data.cityofnewyork.us/resource/erm2-nwe9.json?$select=borough,count(*)&$group=borough';

const res = await fetch(url);
const data = await res.json();

return data.map(row => ({
  borough: row.borough,
  count: parseInt(row.count)
}));
```

### Filter by Date Range
```javascript
// 311 complaints from last 30 days
const thirtyDaysAgo = new Date(Date.now() - 30*24*60*60*1000).toISOString();
const where = encodeURIComponent(`created_date > '${thirtyDaysAgo}'`);
const url = `https://data.cityofnewyork.us/resource/erm2-nwe9.json?$where=${where}&$limit=1000`;

const res = await fetch(url);
return await res.json();
```

### Filter by Location (Zip Code)
```javascript
// Building permits in specific zip code
const zip = '10001';
const where = encodeURIComponent(`postcode = '${zip}'`);
const url = `https://data.cityofnewyork.us/resource/ipu4-2vj7.json?$where=${where}&$limit=100`;

const res = await fetch(url);
return await res.json();
```

### Geospatial Query (within radius)
```javascript
// WiFi hotspots near a point (lat/lon)
const lat = 40.7128;
const lon = -74.0060;
const radius = 1000; // meters
const where = encodeURIComponent(`within_circle(location, ${lat}, ${lon}, ${radius})`);
const url = `https://data.cityofnewyork.us/resource/yjub-udmw.json?$where=${where}`;

const res = await fetch(url);
return await res.json();
```

## SoQL Operators

### Comparison
- `=`, `!=`, `<`, `>`, `<=`, `>=`
- `LIKE '%pattern%'`
- `IN ('value1', 'value2')`
- `BETWEEN x AND y`
- `IS NULL`, `IS NOT NULL`

### Logical
- `AND`, `OR`, `NOT`

### Functions
- `upper()`, `lower()` - String case
- `date_trunc_y()`, `date_trunc_ym()` - Date truncation
- `within_circle()`, `within_box()` - Geospatial
- `count()`, `sum()`, `avg()`, `min()`, `max()` - Aggregates

## Rate Limits
- Without app token: ~1000 requests/hour
- With app token: Higher limits
- Get token at: https://data.cityofnewyork.us/profile/edit/developer_settings

## Popular Queries

### Top complaint types
```javascript
const url = 'https://data.cityofnewyork.us/resource/erm2-nwe9.json?$select=complaint_type,count(*)&$group=complaint_type&$order=count DESC&$limit=10';
```

### Restaurant grades by cuisine
```javascript
const url = 'https://data.cityofnewyork.us/resource/43nn-pn8j.json?$select=cuisine_description,grade,count(*)&$group=cuisine_description,grade&$order=count DESC';
```

## Other NYC Data Portals
- **NYC Planning**: https://www1.nyc.gov/site/planning/data-maps/open-data.page
- **NYC DOT**: Various transportation datasets
- **NYPD**: Crime statistics
