# OpenAlex API

## Overview
Open scholarly metadata database. **No authentication required.**
Contains papers, authors, institutions, venues, and more.

All requests go through the host web-fetch helper: inside codemode call
`codemode.web_fetch({ url, format: 'json' })`. Direct `fetch()` is blocked in codemode.
The helper returns `{ ok, status, contentType, body }` — `body` is always a string, so
parse it with `JSON.parse(res.body)`.

## Base URL
```
https://api.openalex.org
```

## Polite Pool (Recommended)
Add an email parameter for faster rate limits:
```
?mailto=your@email.com
```

## Endpoints

### Search Works (Papers)
```
GET /works?search={query}&per_page={limit}
```

**Parameters:**
- `search` - Free text search
- `filter` - Structured filters (see below)
- `per_page` - Results per page (max 200)
- `page` - Page number
- `sort` - Sort field (e.g., `cited_by_count:desc`)

### Filter Syntax
Filters use `filter=key:value` format:
```
?filter=publication_year:2024
?filter=publication_year:>2020
?filter=is_oa:true
?filter=authorships.author.id:A123456789
```

Multiple filters with comma:
```
?filter=publication_year:2024,is_oa:true
```

### Get Single Work
```
GET /works/{openalex_id}
GET /works/doi:{doi}
```

### Search Authors
```
GET /authors?search={name}
GET /authors/{openalex_id}
```

### Search Institutions
```
GET /institutions?search={name}
```

## Response Format

Works response:
```json
{
  "results": [
    {
      "id": "https://openalex.org/W123456789",
      "doi": "https://doi.org/10.1234/example",
      "title": "Example Paper Title",
      "publication_year": 2024,
      "authorships": [
        {
          "author": {
            "id": "https://openalex.org/A123456789",
            "display_name": "Author Name"
          },
          "institutions": []
        }
      ],
      "cited_by_count": 42,
      "is_oa": true,
      "open_access": { "is_oa": true, "oa_url": "https://..." },
      "abstract_inverted_index": {}
    }
  ],
  "meta": { "count": 1234, "page": 1, "per_page": 25 }
}
```

## Example Code (codemode)

### Search for papers
```javascript
const query = encodeURIComponent('machine learning');
const res = await codemode.web_fetch({
  url: `https://api.openalex.org/works?search=${query}&per_page=10&mailto=your@email.com`,
  format: 'json',
});
const { results, meta } = JSON.parse(res.body);
return results.map((w) => ({
  title: w.title,
  year: w.publication_year,
  doi: w.doi,
  citations: w.cited_by_count,
  isOpenAccess: w.is_oa,
  total: meta.count,
}));
```

### Filter by year and open access
```javascript
const res = await codemode.web_fetch({
  url: 'https://api.openalex.org/works?filter=publication_year:2024,is_oa:true&per_page=25',
  format: 'json',
});
const { results } = JSON.parse(res.body);
```

### Get paper by DOI
```javascript
const doi = '10.1234/example';
const res = await codemode.web_fetch({
  url: `https://api.openalex.org/works/doi:${doi}`,
  format: 'json',
});
const work = JSON.parse(res.body);
```

### Search for author's works
```javascript
// First find the author
const authorRes = await codemode.web_fetch({
  url: 'https://api.openalex.org/authors?search=Jane+Smith',
  format: 'json',
});
const authorId = JSON.parse(authorRes.body).results[0].id.split('/').pop(); // "A123456789"

// Then get their works
const worksRes = await codemode.web_fetch({
  url: `https://api.openalex.org/works?filter=authorships.author.id:${authorId}&per_page=50`,
  format: 'json',
});
const works = JSON.parse(worksRes.body);
```

## Rate Limits
- Without email: 100,000 requests/day, max 10 req/sec
- With email (polite pool): higher limits, faster responses
- Add `&mailto=email@example.com` to requests

## Common Use Cases
- Find scholarly papers on a topic
- Get citation counts
- Check open access availability
- Find author publications
- Discover related work

## Source-forward practice
Every result you show a user should carry its DOI (as a link) and its OpenAlex ID so claims
can be traced back to the record. When you write results into tables, files, or reports,
keep title, year, venue, DOI, and citation count together — and prefer showing the underlying
records over summarizing them without references.
