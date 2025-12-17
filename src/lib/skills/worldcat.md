# OCLC WorldCat API

## Overview
World's largest library catalog - 500M+ bibliographic records.
**Requires OAuth 2.0 authentication.**

## Authentication

WorldCat uses OAuth 2.0 Client Credentials Grant.

```javascript
// Get access token
const credentials = btoa(`${env('OCLC_CLIENT_ID')}:${env('OCLC_CLIENT_SECRET')}`);
const tokenRes = await fetch('https://oauth.oclc.org/token', {
  method: 'POST',
  headers: {
    'Authorization': `Basic ${credentials}`,
    'Content-Type': 'application/x-www-form-urlencoded'
  },
  body: 'grant_type=client_credentials&scope=WorldCatMetadataAPI'
});
const { access_token } = await tokenRes.json();
```

## Metadata API Endpoints

All endpoints use base URL: `https://metadata.api.oclc.org/worldcat`

### Search Books
```
GET /search/brief-bibs
```

**Headers:**
```javascript
{
  'Authorization': `Bearer ${access_token}`,
  'Accept': 'application/json'
}
```

**Parameters:**
- `q` - Search query (CQL format)
- `limit` - Results per page (max 50)
- `offset` - Pagination offset
- `itemType` - Filter by type (e.g., "book")

**Query Examples:**
```
q=ti:Moby Dick                    // Title search
q=au:Melville                     // Author search
q=bn:9780140390841               // ISBN search
q=no:123456                       // OCLC number
q=ti:Moby Dick AND au:Melville   // Combined
```

### Search with Holdings Summary
```
GET /search/bibs-summary-holdings
```

**Returns search results WITH holdings count - use this when you need to know which libraries have an item.**

**Parameters:**
- `oclcNumber` - OCLC number
- `isbn` - ISBN (no dashes)
- `issn` - ISSN (with hyphen)
- `heldBySymbol` - Filter by institution symbol (use env('OCLC_INSTITUTION_ID'))
- `heldInState` - Filter by state (e.g., "US-NY")
- `heldInCountry` - Filter by country

## Response Formats

### Brief Bibs Response
```json
{
  "numberOfRecords": 42,
  "briefRecords": [
    {
      "oclcNumber": "123456",
      "title": "Moby Dick",
      "creator": "Herman Melville",
      "date": "1851",
      "publisher": "Harper & Brothers",
      "isbns": ["9780140390841"],
      "catalogingLanguage": "eng",
      "generalFormat": "Book",
      "specificFormat": "PrintBook"
    }
  ]
}
```

### Summary Holdings Response
```json
{
  "numberOfRecords": 1,
  "briefRecords": [
    {
      "oclcNumber": "123456",
      "title": "Moby-Dick, or, The whale",
      "creator": "Herman Melville",
      "date": "1851",
      "isbns": ["9780140390841"],
      "institutionHolding": {
        "totalHoldingCount": 248,
        "briefHoldings": [
          {
            "oclcSymbol": "NYP",
            "institutionName": "New York Public Library",
            "country": "US",
            "state": "US-NY"
          },
          {
            "oclcSymbol": "DLC",
            "institutionName": "Library of Congress",
            "country": "US",
            "state": "US-DC"
          }
        ]
      }
    }
  ]
}
```

## Example Code

### Full Search Flow
```javascript
// 1. Get access token
const credentials = btoa(`${env('OCLC_CLIENT_ID')}:${env('OCLC_CLIENT_SECRET')}`);
const tokenRes = await fetch('https://oauth.oclc.org/token', {
  method: 'POST',
  headers: {
    'Authorization': `Basic ${credentials}`,
    'Content-Type': 'application/x-www-form-urlencoded'
  },
  body: 'grant_type=client_credentials&scope=WorldCatMetadataAPI'
});
const { access_token } = await tokenRes.json();

// 2. Search for books
const query = encodeURIComponent('ti:machine learning');
const searchRes = await fetch(
  `https://metadata.api.oclc.org/worldcat/search/brief-bibs?q=${query}&limit=10`,
  { headers: { 'Authorization': `Bearer ${access_token}`, 'Accept': 'application/json' } }
);
const { briefRecords } = await searchRes.json();

// 3. Display results
await setTable("books", {
  title: "WorldCat Results",
  columns: [
    { key: "title", label: "Title", type: "text" },
    { key: "author", label: "Author", type: "text" },
    { key: "year", label: "Year", type: "number" },
    { key: "isbn", label: "ISBN", type: "text" }
  ],
  data: briefRecords.map(r => ({
    title: r.title,
    author: r.creator,
    year: r.date,
    isbn: r.isbns?.[0] || "N/A"
  }))
});

return `Found ${briefRecords.length} books`;
```

### Check Holdings by ISBN
```javascript
// After getting access_token...
const isbn = '9780140390841';
const holdingsRes = await fetch(
  `https://metadata.api.oclc.org/worldcat/search/bibs-summary-holdings?isbn=${isbn}`,
  { headers: { 'Authorization': `Bearer ${access_token}`, 'Accept': 'application/json' } }
);
const data = await holdingsRes.json();

if (data.numberOfRecords > 0) {
  const record = data.briefRecords[0];
  const holdings = record.institutionHolding;

  log(`"${record.title}" is held by ${holdings.totalHoldingCount} libraries`);

  // Show some holding libraries
  await setTable("holdings", {
    title: `Libraries with "${record.title}"`,
    columns: [
      { key: "name", label: "Library", type: "text" },
      { key: "symbol", label: "Symbol", type: "text" },
      { key: "state", label: "State", type: "text" }
    ],
    data: holdings.briefHoldings.slice(0, 20).map(h => ({
      name: h.institutionName,
      symbol: h.oclcSymbol,
      state: h.state
    }))
  });
}
```

### Check if Your Institution Has Item
```javascript
// Check if your institution has a book
const institutionSymbol = env('OCLC_INSTITUTION_ID');
const oclcNumber = '123456';
const checkRes = await fetch(
  `https://metadata.api.oclc.org/worldcat/search/bibs-summary-holdings?oclcNumber=${oclcNumber}&heldBySymbol=${institutionSymbol}`,
  { headers: { 'Authorization': `Bearer ${access_token}`, 'Accept': 'application/json' } }
);
const checkData = await checkRes.json();
const hasItem = checkData.numberOfRecords > 0;

log(`Your institution ${hasItem ? 'HAS' : 'does NOT have'} this item`);
```

## Environment Variables
```
OCLC_CLIENT_ID     - OAuth client ID
OCLC_CLIENT_SECRET - OAuth client secret
OCLC_INSTITUTION_ID - Your institution symbol (e.g., "ZGM")
```

## Common Institution Symbols
Your institution's symbol is available via `env('OCLC_INSTITUTION_ID')`.

Examples of well-known symbols:
- `DLC` - Library of Congress
- `NYP` - New York Public Library
- `ZCU` - Columbia University
- `HVD` - Harvard University

## Best Practices
- Start with broad searches, narrow if needed
- Use ISBN when available (most reliable)
- Use `bibs-summary-holdings` when you need holdings info (1 call gets everything)
- Use `brief-bibs` for quick searches without holdings
- Filter by `heldBySymbol` to check specific library availability
- Cache access tokens (valid ~20 minutes)
