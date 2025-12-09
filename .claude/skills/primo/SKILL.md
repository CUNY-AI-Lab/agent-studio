---
name: primo
description: Search CUNY OneSearch / library catalog via Ex Libris Primo API. Find books, e-books, journals, articles available at CUNY libraries. Check availability, get call numbers, find items at specific campuses. Example queries: 'search CUNY library for machine learning books', 'does CUNY have this ISBN', 'find books at Graduate Center library', 'check library availability'.
---

# Ex Libris Primo API

## Overview
Library catalog search API from Ex Libris. Used by many academic libraries.
**Requires API key.**

## Base URL
```
https://api-na.hosted.exlibrisgroup.com/primo/v1/search
```
(URL varies by region - check env('PRIMO_BASE_URL'))

## Authentication

Add API key to requests:
```javascript
const apiKey = env('PRIMO_API_KEY');
const vid = env('PRIMO_VID');      // View ID, e.g., "01CUNY_GC:CUNY_GC"
const scope = env('PRIMO_SCOPE');  // Search scope, e.g., "IZ_CI_AW"
```

## Search Endpoint

```
GET {PRIMO_BASE_URL}?q={query}&vid={vid}&scope={scope}&apikey={apiKey}
```

**Required Parameters:**
- `q` - Search query
- `vid` - View ID
- `scope` - Search scope
- `apikey` - API key

**Optional Parameters:**
- `limit` - Results per page (default 10, max 50)
- `offset` - Pagination offset
- `sort` - Sort order: `rank`, `date`, `author`, `title`
- `lang` - Language code

## Query Syntax

Primo uses a structured query format:
```
q=field,operator,value
```

**Fields:**
- `any` - All fields
- `title` - Title
- `creator` - Author
- `sub` - Subject
- `isbn` - ISBN
- `issn` - ISSN

**Operators:**
- `contains` - Partial match
- `exact` - Exact match
- `begins_with` - Starts with

**Examples:**
```
q=any,contains,machine learning
q=title,contains,data science
q=creator,contains,Smith
q=isbn,exact,9780123456789
```

## Response Format

```json
{
  "info": {
    "total": 1234,
    "first": 0,
    "last": 9
  },
  "docs": [
    {
      "pnx": {
        "control": {
          "recordid": ["CUNY123456"]
        },
        "display": {
          "title": ["Introduction to Machine Learning"],
          "creator": ["Author Name"],
          "publisher": ["Publisher Name"],
          "creationdate": ["2024"],
          "format": ["Book"],
          "subject": ["Machine learning", "Artificial intelligence"]
        },
        "addata": {
          "isbn": ["9780123456789"],
          "doi": ["10.1234/example"]
        }
      },
      "delivery": {
        "availability": ["available"],
        "holding": [
          {
            "libraryCode": "MAIN",
            "callNumber": "Q325.5 .A87 2024",
            "availabilityStatus": "available"
          }
        ]
      }
    }
  ]
}
```

## Building Catalog Links

To link users to the catalog record, use the discovery URL with the record ID:

```javascript
const discoveryUrl = env('PRIMO_DISCOVERY_URL');  // e.g., https://cuny-gc.primo.exlibrisgroup.com
const vid = env('PRIMO_VID');                      // e.g., 01CUNY_GC:CUNY_GC

// Build catalog URL from record ID
function getCatalogUrl(recordId) {
  return `${discoveryUrl}/discovery/fulldisplay?docid=${recordId}&context=L&vid=${vid}`;
}

// Example: getCatalogUrl('alma991234567890')
// Returns: https://cuny-gc.primo.exlibrisgroup.com/discovery/fulldisplay?docid=alma991234567890&context=L&vid=01CUNY_GC:CUNY_GC
```

## Example Code

### Basic Search
```javascript
const baseUrl = env('PRIMO_BASE_URL');
const apiKey = env('PRIMO_API_KEY');
const vid = env('PRIMO_VID');
const scope = env('PRIMO_SCOPE');
const discoveryUrl = env('PRIMO_DISCOVERY_URL');

const query = 'any,contains,machine learning';
const url = `${baseUrl}?q=${encodeURIComponent(query)}&vid=${vid}&scope=${scope}&limit=10&apikey=${apiKey}`;

const res = await fetch(url);
const data = await res.json();

return data.docs.map(doc => {
  const recordId = doc.pnx.control.recordid?.[0];
  return {
    title: doc.pnx.display.title?.[0],
    author: doc.pnx.display.creator?.[0],
    year: doc.pnx.display.creationdate?.[0],
    format: doc.pnx.display.format?.[0],
    isbn: doc.pnx.addata?.isbn?.[0],
    available: doc.delivery?.availability?.[0] === 'available',
    catalogUrl: `${discoveryUrl}/discovery/fulldisplay?docid=${recordId}&context=L&vid=${vid}`
  };
});
```

### Search by ISBN
```javascript
const isbn = '9780123456789';
const query = `isbn,exact,${isbn}`;
const url = `${baseUrl}?q=${encodeURIComponent(query)}&vid=${vid}&scope=${scope}&apikey=${apiKey}`;

const res = await fetch(url);
const data = await res.json();

if (data.docs.length > 0) {
  const doc = data.docs[0];
  log('Found:', doc.pnx.display.title?.[0]);
  log('Available:', doc.delivery?.availability?.[0]);
}
```

### Check If Library Owns Item
```javascript
async function checkLibraryOwns(isbn) {
  const query = `isbn,exact,${isbn}`;
  const url = `${baseUrl}?q=${encodeURIComponent(query)}&vid=${vid}&scope=${scope}&apikey=${apiKey}`;

  const res = await fetch(url);
  const data = await res.json();

  return data.info.total > 0;
}

const owns = await checkLibraryOwns('9780123456789');
log(`Library owns this item: ${owns}`);
```

## Environment Variables
```
PRIMO_API_KEY      - API key
PRIMO_VID          - View ID (institution-specific)
PRIMO_SCOPE        - Search scope
PRIMO_BASE_URL     - API base URL (region-specific)
PRIMO_DISCOVERY_URL - Discovery UI base URL for catalog links
```

## Common Use Cases
- Check if library owns a specific book (by ISBN)
- Search catalog by title, author, subject
- Check availability status
- Get call numbers and locations
