---
name: census
description: Access US Census Bureau data including demographics, economic indicators, housing, and population statistics. American Community Survey (ACS), Decennial Census, Economic Census. Example queries: 'population of NYC', 'median income by zip code', 'housing data for Manhattan'. API key recommended for heavy use.
---

# US Census Bureau API

## Overview
Access demographic, economic, housing, and population data for the United States at various geographic levels (nation, state, county, tract, zip code).
**No authentication required** for basic use, but API key recommended.

## Get API Key (Optional)
Request at: https://api.census.gov/data/key_signup.html

## Base URL
```
https://api.census.gov/data
```

## Available Datasets

| Dataset | Endpoint | Description |
|---------|----------|-------------|
| ACS 5-Year | `/2022/acs/acs5` | American Community Survey (detailed, small areas) |
| ACS 1-Year | `/2023/acs/acs1` | More recent but less detailed |
| Decennial Census | `/2020/dec/pl` | Population counts from 2020 Census |
| Population Estimates | `/2023/pep/population` | Annual population estimates |

## Finding Variables

Variable explorer: https://api.census.gov/data/2022/acs/acs5/variables.html

Common variables:
| Variable | Description |
|----------|-------------|
| `B01003_001E` | Total population |
| `B01002_001E` | Median age |
| `B19013_001E` | Median household income |
| `B25077_001E` | Median home value |
| `B25064_001E` | Median gross rent |
| `B23025_005E` | Unemployed population |
| `B15003_022E` | Bachelor's degree holders |
| `B03002_003E` | White (non-Hispanic) population |
| `B03002_004E` | Black population |
| `B03002_006E` | Asian population |
| `B03002_012E` | Hispanic/Latino population |

## Geographic Levels

| Level | Code | Example |
|-------|------|---------|
| Nation | `us:*` | United States |
| State | `state:36` | New York (FIPS 36) |
| County | `county:061` | Manhattan (NY County) |
| Tract | `tract:*` | Census tracts |
| ZIP Code | `zip code tabulation area:10001` | ZIP 10001 |

State FIPS codes: https://www2.census.gov/geo/docs/reference/codes/files/national_state.txt

## Example Code

### Get Population by State
```javascript
const vars = 'NAME,B01003_001E'; // Name and total population
const url = `https://api.census.gov/data/2022/acs/acs5?get=${vars}&for=state:*`;

const res = await fetch(url);
const data = await res.json();

// First row is headers
const headers = data[0];
const rows = data.slice(1);

const results = rows.map(row => ({
  name: row[0],
  population: parseInt(row[1]),
  stateCode: row[2]
})).sort((a, b) => b.population - a.population);

await setTable('population', {
  title: 'US Population by State',
  columns: [
    { key: 'name', label: 'State', type: 'text' },
    { key: 'population', label: 'Population', type: 'number' }
  ],
  data: results
});

return results;
```

### Get NYC Demographics (Counties = Boroughs)
```javascript
// NYC boroughs as counties: Manhattan=061, Bronx=005, Brooklyn=047, Queens=081, Staten Island=085
const boroughs = ['061', '005', '047', '081', '085'];
const vars = 'NAME,B01003_001E,B19013_001E,B01002_001E';  // Pop, income, age

const results = await Promise.all(boroughs.map(async county => {
  const url = `https://api.census.gov/data/2022/acs/acs5?get=${vars}&for=county:${county}&in=state:36`;
  const res = await fetch(url);
  const data = await res.json();
  const row = data[1];  // Skip header

  return {
    borough: row[0].replace(' County, New York', ''),
    population: parseInt(row[1]),
    medianIncome: parseInt(row[2]),
    medianAge: parseFloat(row[3])
  };
}));

await setTable('nyc-demographics', {
  title: 'NYC Borough Demographics',
  columns: [
    { key: 'borough', label: 'Borough', type: 'text' },
    { key: 'population', label: 'Population', type: 'number' },
    { key: 'medianIncome', label: 'Median Income', type: 'number' },
    { key: 'medianAge', label: 'Median Age', type: 'number' }
  ],
  data: results
});

return results;
```

### Get Data by ZIP Code
```javascript
const zipCode = '10001';  // Chelsea, Manhattan
const vars = 'NAME,B01003_001E,B19013_001E,B25064_001E,B25077_001E';

const url = `https://api.census.gov/data/2022/acs/acs5?get=${vars}&for=zip%20code%20tabulation%20area:${zipCode}`;
const res = await fetch(url);
const data = await res.json();

const [headers, row] = [data[0], data[1]];

return {
  zipCode: row[5],
  population: parseInt(row[1]),
  medianIncome: parseInt(row[2]),
  medianRent: parseInt(row[3]),
  medianHomeValue: parseInt(row[4])
};
```

### Race/Ethnicity Breakdown
```javascript
const state = '36';  // New York
const county = '061';  // Manhattan

const vars = [
  'NAME',
  'B03002_001E',  // Total
  'B03002_003E',  // White alone (non-Hispanic)
  'B03002_004E',  // Black alone
  'B03002_006E',  // Asian alone
  'B03002_012E'   // Hispanic/Latino
].join(',');

const url = `https://api.census.gov/data/2022/acs/acs5?get=${vars}&for=county:${county}&in=state:${state}`;
const res = await fetch(url);
const data = await res.json();
const row = data[1];

const total = parseInt(row[1]);
const breakdown = {
  area: row[0],
  total,
  white: { count: parseInt(row[2]), pct: (parseInt(row[2]) / total * 100).toFixed(1) },
  black: { count: parseInt(row[3]), pct: (parseInt(row[3]) / total * 100).toFixed(1) },
  asian: { count: parseInt(row[4]), pct: (parseInt(row[4]) / total * 100).toFixed(1) },
  hispanic: { count: parseInt(row[5]), pct: (parseInt(row[5]) / total * 100).toFixed(1) }
};

await setChart('demographics', {
  type: 'pie',
  data: [
    { category: 'White', value: breakdown.white.count },
    { category: 'Black', value: breakdown.black.count },
    { category: 'Asian', value: breakdown.asian.count },
    { category: 'Hispanic/Latino', value: breakdown.hispanic.count },
    { category: 'Other', value: total - breakdown.white.count - breakdown.black.count - breakdown.asian.count - breakdown.hispanic.count }
  ],
  xKey: 'category',
  yKey: 'value'
});

return breakdown;
```

### Compare Multiple Areas
```javascript
// Compare median income across NYC boroughs vs national median
const areas = [
  { name: 'Manhattan', geo: 'county:061', state: '36' },
  { name: 'Brooklyn', geo: 'county:047', state: '36' },
  { name: 'Queens', geo: 'county:081', state: '36' },
  { name: 'Bronx', geo: 'county:005', state: '36' },
  { name: 'Staten Island', geo: 'county:085', state: '36' }
];

const results = await Promise.all(areas.map(async area => {
  const url = `https://api.census.gov/data/2022/acs/acs5?get=B19013_001E&for=${area.geo}&in=state:${area.state}`;
  const res = await fetch(url);
  const data = await res.json();
  return {
    area: area.name,
    medianIncome: parseInt(data[1][0])
  };
}));

// Get national median
const natUrl = 'https://api.census.gov/data/2022/acs/acs5?get=B19013_001E&for=us:*';
const natRes = await fetch(natUrl);
const natData = await natRes.json();
results.push({ area: 'US National', medianIncome: parseInt(natData[1][0]) });

await setChart('income-comparison', {
  type: 'bar',
  data: results,
  xKey: 'area',
  yKey: 'medianIncome',
  title: 'Median Household Income'
});

return results;
```

## API Response Format

Response is a 2D array where first row is headers:
```json
[
  ["NAME", "B01003_001E", "state"],
  ["California", "39538223", "06"],
  ["Texas", "29145505", "48"]
]
```

## Rate Limits
- Without API key: 500 requests/day
- With API key: 50,000 requests/day
- Add `key=YOUR_KEY` to query string

## FIPS Codes Reference

NYC Boroughs (state=36):
- Manhattan: county=061
- Bronx: county=005
- Brooklyn: county=047
- Queens: county=081
- Staten Island: county=085

Major States:
- California: 06
- Texas: 48
- Florida: 12
- New York: 36
- Illinois: 17

## Tips
- Use ACS 5-year for small geographies (most complete data)
- Use ACS 1-year for most recent data (larger areas only)
- Variable names ending in 'E' are estimates, 'M' are margins of error
- ZIP codes are actually ZCTAs (may differ slightly from USPS ZIPs)
- Combine with NYC Open Data for local comparisons
