---
name: worldcat
description: Search physical books across 10,000+ libraries worldwide. Returns: title, author, publisher, publication date, ISBN, which libraries hold copies. Example queries: 'find books about jazz history', 'novels by Toni Morrison', 'where can I borrow a copy of 1984'. Requires OAuth.
---

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
  body: 'grant_type=client_credentials&scope=wcapi:view_holdings wcapi:view_institution_holdings WorldCatMetadataAPI'
});
const { access_token } = await tokenRes.json();
```

## Search API V2 (Recommended)

### Search Books
```
GET https://americas.discovery.api.oclc.org/worldcat/search/v2/bibs
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

**Query Examples:**
```
q=ti:Moby Dick                    // Title search
q=au:Melville                     // Author search
q=bn:9780140390841               // ISBN search
q=no:123456                       // OCLC number
q=ti:Moby Dick AND au:Melville   // Combined
```

### Get Holdings (All Institutions)
```
GET https://americas.discovery.api.oclc.org/worldcat/search/v2/bibs-holdings
```

**Parameters:**
- `oclcNumber` - The OCLC number

**Returns all institutions holding the item in ONE call.**

## Response Format

### Search Response
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

### Holdings Response
```json
{
  "briefRecords": [
    {
      "oclcNumber": "123456",
      "institutionHolding": {
        "totalHoldingCount": 65,
        "briefHoldings": [
          {
            "oclcSymbol": "ZGM",
            "institutionName": "CUNY Graduate Center",
            "country": "US"
          },
          {
            "oclcSymbol": "NYP",
            "institutionName": "New York Public Library",
            "country": "US"
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
  body: 'grant_type=client_credentials&scope=wcapi:view_holdings WorldCatMetadataAPI'
});
const { access_token } = await tokenRes.json();

// 2. Search for books
const query = encodeURIComponent('ti:machine learning');
const searchRes = await fetch(
  `https://americas.discovery.api.oclc.org/worldcat/search/v2/bibs?q=${query}&limit=10`,
  { headers: { 'Authorization': `Bearer ${access_token}`, 'Accept': 'application/json' } }
);
const { briefRecords } = await searchRes.json();

// 3. Display results
return briefRecords.map(r => ({
  oclcNumber: r.oclcNumber,
  title: r.title,
  author: r.creator,
  year: r.date,
  isbns: r.isbns
}));
```

### Check Holdings
```javascript
// After getting access_token...
const oclcNumber = '123456';
const holdingsRes = await fetch(
  `https://americas.discovery.api.oclc.org/worldcat/search/v2/bibs-holdings?oclcNumber=${oclcNumber}`,
  { headers: { 'Authorization': `Bearer ${access_token}`, 'Accept': 'application/json' } }
);
const data = await holdingsRes.json();

const holdings = data.briefRecords[0]?.institutionHolding;
log(`Total libraries: ${holdings.totalHoldingCount}`);

// Extract institution symbols
const symbols = holdings.briefHoldings.map(h => h.oclcSymbol);
return symbols;
```

## Environment Variables
```
OCLC_CLIENT_ID     - OAuth client ID
OCLC_CLIENT_SECRET - OAuth client secret
OCLC_INSTITUTION_ID - Your institution symbol (e.g., "ZGM")
```

## Common Institution Symbols
- `DLC` - Library of Congress
- `NYP` - New York Public Library
- `ZGM` - CUNY Graduate Center
- `ZCU` - Columbia University

## Best Practices
- Start with broad searches, narrow if needed
- Use ISBN when available (most reliable)
- Get holdings with bibs-holdings endpoint (1 call vs many)
- Cache access tokens (valid ~20 minutes)
