---
name: unpaywall
description: Find free/open access versions of scholarly articles by DOI. Check if a paper has a free PDF available. Returns OA status, PDF links, publisher info. Example queries: 'is there a free version of this paper', 'find open access PDF for DOI 10.1234/example', 'check OA status'. No auth required (just email).
---

# Unpaywall API

## Overview
Find open access versions of scholarly articles using their DOI. Unpaywall indexes 25,000+ OA journals, repositories, and preprint servers.
**No API key required** - just include your email in requests.

## Base URL
```
https://api.unpaywall.org/v2
```

## Get OA Status by DOI

```
GET /v2/{doi}?email={your_email}
```

**Parameters:**
- `doi` - The DOI (e.g., `10.1038/nature12373`)
- `email` - Your email address (required, for rate limiting)

## Response Format

```json
{
  "doi": "10.1038/nature12373",
  "title": "Article Title",
  "is_oa": true,
  "oa_status": "green",
  "best_oa_location": {
    "url": "https://example.com/paper.pdf",
    "url_for_pdf": "https://example.com/paper.pdf",
    "host_type": "repository",
    "license": "cc-by",
    "version": "publishedVersion"
  },
  "oa_locations": [
    {
      "url": "https://...",
      "url_for_pdf": "https://...",
      "host_type": "repository",
      "license": "cc-by"
    }
  ],
  "journal_name": "Nature",
  "publisher": "Springer Nature",
  "published_date": "2013-07-17",
  "year": 2013
}
```

## OA Status Values
- `gold` - Published in OA journal
- `hybrid` - OA in subscription journal
- `bronze` - Free to read on publisher site
- `green` - Available in repository/preprint
- `closed` - No OA version found

## Example Code

### Check if paper has OA version
```javascript
const doi = '10.1038/nature12373';
const email = env('OPENALEX_EMAIL'); // Use configured email
const url = `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${email}`;

const res = await fetch(url);
const data = await res.json();

if (data.is_oa && data.best_oa_location) {
  return {
    title: data.title,
    isOpenAccess: true,
    oaStatus: data.oa_status,
    pdfUrl: data.best_oa_location.url_for_pdf || data.best_oa_location.url,
    license: data.best_oa_location.license,
    source: data.best_oa_location.host_type
  };
} else {
  return {
    title: data.title,
    isOpenAccess: false,
    message: 'No open access version found'
  };
}
```

### Check multiple DOIs
```javascript
const dois = ['10.1038/nature12373', '10.1126/science.1234567'];
const email = 'your@email.com';

const results = await Promise.all(dois.map(async doi => {
  const res = await fetch(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${email}`);
  const data = await res.json();
  return {
    doi,
    title: data.title,
    isOA: data.is_oa,
    pdfUrl: data.best_oa_location?.url_for_pdf
  };
}));

return results;
```

### Find OA version from CrossRef/OpenAlex result
```javascript
// If you have a DOI from another search
async function getOALink(doi, email) {
  const res = await fetch(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${email}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.best_oa_location?.url_for_pdf || data.best_oa_location?.url || null;
}

const oaUrl = await getOALink('10.1038/nature12373', 'your@email.com');
log('OA PDF:', oaUrl);
```

## Rate Limits
- 100,000 requests per day (shared across all users without tokens)
- Include email in requests for polite pool access
- For higher limits, contact Unpaywall for API key

## Common Use Cases
- Check if a paper has a free PDF before paying
- Add OA links to search results from other APIs
- Build reading lists with free access links
- Verify OA status for compliance

## Tips
- Always check `url_for_pdf` first, fall back to `url`
- `green` status often means preprint/repository version
- `gold` means the publisher version is freely available
- Combine with CrossRef/OpenAlex to search then get OA links
