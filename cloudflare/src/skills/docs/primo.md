# Ex Libris Primo API

## Overview
Library catalog search API from Ex Libris, used by many academic libraries (e.g., CUNY OneSearch).
Find books, e-books, journals, and articles; check availability and call numbers.

## Authentication — handled by the host
When this deployment has Primo configured, the host web-fetch helper **automatically attaches**
the required `apikey`, `vid`, and `scope` query parameters to Primo requests. Do NOT ask the
user for API keys or view IDs, and do NOT include those parameters yourself — just omit them.

If a Primo request returns an error saying Primo is not configured, tell the user that
library catalog search isn't available on this deployment and offer OpenAlex or CrossRef
as alternatives for finding the material.

Make requests from codemode with `codemode.web_fetch({ url, format: 'json' })` — direct
`fetch()` is blocked. Parse the string body with `JSON.parse(res.body)`.

## Search Endpoint
```
GET https://api-na.hosted.exlibrisgroup.com/primo/v1/search?q={query}
```
(The region-specific base URL and institution parameters are the host's concern; you only
supply `q` and the optional parameters below.)

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
  "info": { "total": 1234, "first": 0, "last": 9 },
  "docs": [
    {
      "pnx": {
        "control": { "recordid": ["CUNY123456"] },
        "display": {
          "title": ["Introduction to Machine Learning"],
          "creator": ["Author Name"],
          "publisher": ["Publisher Name"],
          "creationdate": ["2024"],
          "format": ["Book"],
          "subject": ["Machine learning", "Artificial intelligence"]
        },
        "addata": { "isbn": ["9780123456789"], "doi": ["10.1234/example"] }
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

```javascript
const availabilityLabels = {
  available_in_library: 'In Library',
  not_restricted: 'Online Access',
  Loan: 'Available for Loan',
  check_holdings: 'Check Holdings',
};
```

## Catalog Record Links

The record ID from `pnx.control.recordid` identifies the catalog record. When the
deployment provides a discovery UI base URL, direct links follow this format:
```
{discoveryBase}/discovery/fulldisplay?docid={recordId}&vid={vid}&context=L
```

**IMPORTANT:**
- Do NOT construct links from title searches — they are unreliable. Use the record ID.
- If you don't know the deployment's discovery base URL, show the record ID, call number,
  and library location instead of fabricating a URL.
- Never display a raw URL to users — render links as markdown (`[View in Catalog](url)`)
  in panels, tables, or files, with descriptive text like "View in Catalog".

## Example Code (codemode)

### Basic search
```javascript
const query = 'any,contains,machine learning';
const res = await codemode.web_fetch({
  url: `https://api-na.hosted.exlibrisgroup.com/primo/v1/search?q=${encodeURIComponent(query)}&limit=10`,
  format: 'json',
});
const data = JSON.parse(res.body);

if (!res.ok) {
  // If the error indicates Primo is not configured on this deployment,
  // tell the user and offer OpenAlex/CrossRef instead.
  return { error: data };
}

return data.docs.map((doc) => {
  const raw = doc.delivery?.availability?.[0];
  return {
    recordId: doc.pnx.control.recordid?.[0],
    title: doc.pnx.display.title?.[0],
    author: doc.pnx.display.creator?.[0],
    year: doc.pnx.display.creationdate?.[0],
    format: doc.pnx.display.format?.[0],
    isbn: doc.pnx.addata?.isbn?.[0],
    availability: availabilityLabels[raw] || raw || '-',
    callNumber: doc.delivery?.holding?.[0]?.callNumber,
  };
});
```

### Search by ISBN / check if the library owns an item
```javascript
const isbn = '9780123456789';
const res = await codemode.web_fetch({
  url: `https://api-na.hosted.exlibrisgroup.com/primo/v1/search?q=${encodeURIComponent(`isbn,exact,${isbn}`)}`,
  format: 'json',
});
const data = JSON.parse(res.body);
const owns = data.info.total > 0;
```

## Common Use Cases
- Check if the library owns a specific book (by ISBN)
- Search catalog by title, author, subject
- Check availability status
- Get call numbers and locations

## Source-forward practice
Catalog answers should point at catalog records: include the Primo record ID (and a direct
fulldisplay link when the discovery base is known), call number, and holding library with
every item you report. Never tell a user "the library has it" without surfacing the record
that proves it.
