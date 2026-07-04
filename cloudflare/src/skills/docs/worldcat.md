# OCLC WorldCat API

## Overview
The world's largest library catalog — 500M+ bibliographic records across 10,000+
libraries. Use it to find books, get bibliographic metadata, and see which
libraries hold a copy worldwide.

## Authentication — handled by the host
This deployment uses OAuth 2.0 client credentials, but **the host attaches the
bearer token for you**. When WorldCat is configured, the host web-fetch helper
acquires and injects `Authorization: Bearer <token>` on requests to the WorldCat
API host. Do NOT ask the user for keys, do NOT call the token endpoint, and do
NOT add an Authorization header yourself — just make the search request.

If a WorldCat request returns an error indicating the API is not configured (or
a persistent 401), tell the user that WorldCat search isn't available on this
deployment and offer OpenAlex or CrossRef for bibliographic discovery, or Primo
to check the local library catalog.

Make requests from codemode with `codemode.web_fetch({ url, format: 'json' })` —
direct `fetch()` is blocked. Parse the string body with `JSON.parse(res.body)`.

## Metadata API Endpoints

All endpoints use base URL: `https://metadata.api.oclc.org/worldcat`

### Search Books
```
GET /search/brief-bibs
```

**Parameters:**
- `q` — Search query (CQL format)
- `limit` — Results per page (max 50)
- `offset` — Pagination offset
- `itemType` — Filter by type (e.g., "book")

**Query Examples:**
```
q=ti:Moby Dick                    // Title search
q=au:Melville                     // Author search
q=bn:9780140390841                // ISBN search
q=no:123456                       // OCLC number
q=ti:Moby Dick AND au:Melville    // Combined
```

### Search with Holdings Summary
```
GET /search/bibs-summary-holdings
```

Returns search results **with** holdings counts — use this when you need to know
which libraries have an item.

**Parameters:**
- `oclcNumber` — OCLC number
- `isbn` — ISBN (no dashes)
- `issn` — ISSN (with hyphen)
- `heldBySymbol` — Filter by institution symbol
- `heldInState` — Filter by state (e.g., "US-NY")
- `heldInCountry` — Filter by country

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
          }
        ]
      }
    }
  ]
}
```

## Example Code (codemode)

### Basic search
```javascript
const query = encodeURIComponent('ti:machine learning');
const res = await codemode.web_fetch({
  url: `https://metadata.api.oclc.org/worldcat/search/brief-bibs?q=${query}&limit=10`,
  format: 'json',
});
const data = JSON.parse(res.body);

if (!res.ok) {
  // If the error indicates WorldCat is not configured on this deployment,
  // tell the user and offer OpenAlex/CrossRef/Primo instead.
  return { error: data };
}

return (data.briefRecords || []).map((r) => ({
  oclcNumber: r.oclcNumber,
  title: r.title,
  author: r.creator,
  year: r.date,
  isbn: r.isbns?.[0] || null,
  format: r.specificFormat || r.generalFormat,
}));
```

### Check holdings by ISBN
```javascript
const isbn = '9780140390841';
const res = await codemode.web_fetch({
  url: `https://metadata.api.oclc.org/worldcat/search/bibs-summary-holdings?isbn=${isbn}`,
  format: 'json',
});
const data = JSON.parse(res.body);

if (data.numberOfRecords > 0) {
  const record = data.briefRecords[0];
  const holdings = record.institutionHolding;
  return {
    title: record.title,
    oclcNumber: record.oclcNumber,
    heldBy: holdings.totalHoldingCount,
    libraries: holdings.briefHoldings.slice(0, 20).map((h) => ({
      name: h.institutionName,
      symbol: h.oclcSymbol,
      state: h.state,
    })),
  };
}
```

## Best Practices
- Start with broad searches, narrow if needed.
- Use ISBN when available (most reliable).
- Use `bibs-summary-holdings` when you need holdings info (one call gets
  everything); use `brief-bibs` for quick searches without holdings.
- Filter by `heldBySymbol` to check a specific library's availability.

## Source-forward practice
WorldCat answers should point at the record that proves them: include the OCLC
number for every item you report, and link to the WorldCat record with
`https://search.worldcat.org/title/{oclcNumber}`. When you report holdings, name
the holding libraries (institution name + symbol) rather than asserting "many
libraries have it." Never claim a library holds an item without surfacing the
holdings record. Render links as markdown (e.g. `[View in WorldCat](url)`),
never a raw URL.
