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

## Availability Values

The `delivery.availability` field contains access status. Use clear display labels:

| API Value | Display Label | Meaning |
|-----------|---------------|---------|
| `available_in_library` | In Library | Physical copy available on shelf |
| `not_restricted` | Online Access | Digital/electronic access, no restrictions |
| `Loan` | Available for Loan | Can be borrowed |
| `check_holdings` | Check Holdings | Need to verify specific location |

**Example mapping for display:**
```javascript
function formatAvailability(value) {
  const labels = {
    'available_in_library': 'In Library',
    'not_restricted': 'Online Access',
    'Loan': 'Available for Loan',
    'check_holdings': 'Check Holdings'
  };
  return labels[value] || value;
}
```

## Direct Record Links

To link directly to a catalog record, use the record ID from `pnx.control.recordid`:

```javascript
// Construct direct link to record (NOT a search URL)
const recordId = doc.pnx.control.recordid?.[0];
const vid = env('PRIMO_VID');
const discoveryBase = env('PRIMO_DISCOVERY_URL'); // e.g., "https://your-institution.primo.exlibrisgroup.com"

// Direct link format:
const catalogLink = `${discoveryBase}/discovery/fulldisplay?docid=${recordId}&vid=${vid}&context=L`;
```

**IMPORTANT:** Do NOT construct links using title searches - they are unreliable. Always use the record ID for direct links.

## Displaying Clickable Catalog Links

When displaying catalog links to users, **always make them clickable**:

### In Tables
Use a column with `type: "url"` to render clickable links:
```javascript
await setTable("results", {
  title: "Search Results",
  columns: [
    { key: "title", label: "Title", type: "text" },
    { key: "author", label: "Author", type: "text" },
    { key: "catalogLink", label: "Catalog", type: "url", linkText: "View in Catalog" }
  ],
  data: results
});
```

### In Cards
Include the link in card metadata or description with markdown:
```javascript
await setCards("results", {
  title: "Library Results",
  items: results.map(r => ({
    title: r.title,
    subtitle: r.author,
    description: `[View in Catalog](${r.catalogLink})`
  }))
});
```

### In Markdown
Use standard markdown link syntax:
```javascript
await setMarkdown("result", {
  title: "Found Item",
  content: `## ${title}\n\n[Open in Library Catalog](${catalogLink})`
});
```

**Never display a raw URL** - always render it as a clickable link with descriptive text like "View in Catalog" or "Open in Library Catalog".

## Example Code

### Basic Search
```javascript
const baseUrl = env('PRIMO_BASE_URL');
const apiKey = env('PRIMO_API_KEY');
const vid = env('PRIMO_VID');
const scope = env('PRIMO_SCOPE');

// Map API values to user-friendly labels
const availabilityLabels = {
  'available_in_library': 'In Library',
  'not_restricted': 'Online Access',
  'Loan': 'Available for Loan',
  'check_holdings': 'Check Holdings'
};

const query = 'any,contains,machine learning';
const url = `${baseUrl}?q=${encodeURIComponent(query)}&vid=${vid}&scope=${scope}&limit=10&apikey=${apiKey}`;

const res = await fetch(url);
const data = await res.json();

return data.docs.map(doc => {
  const rawAvailability = doc.delivery?.availability?.[0];
  const recordId = doc.pnx.control.recordid?.[0];
  return {
    title: doc.pnx.display.title?.[0],
    author: doc.pnx.display.creator?.[0],
    year: doc.pnx.display.creationdate?.[0],
    format: doc.pnx.display.format?.[0],
    isbn: doc.pnx.addata?.isbn?.[0],
    availability: availabilityLabels[rawAvailability] || rawAvailability || '-',
    // Direct link using record ID (not a search URL)
    catalogLink: recordId
      ? `${env('PRIMO_DISCOVERY_URL')}/discovery/fulldisplay?docid=${recordId}&vid=${vid}&context=L`
      : null
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
PRIMO_DISCOVERY_URL - Discovery UI base URL for catalog links (e.g., https://your-institution.primo.exlibrisgroup.com)
```

## Common Use Cases
- Check if library owns a specific book (by ISBN)
- Search catalog by title, author, subject
- Check availability status
- Get call numbers and locations
