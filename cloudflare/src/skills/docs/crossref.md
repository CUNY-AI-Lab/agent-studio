# CrossRef API

## Overview
The official DOI registry with metadata for 150M+ scholarly works. **No authentication required.**
Excellent for: DOI resolution, citation counts, reference lists, publisher metadata.

Make requests from codemode with `codemode.web_fetch({ url, format: 'json' })` — direct
`fetch()` is blocked. The helper returns `{ ok, status, contentType, body }`; parse the
string body with `JSON.parse(res.body)`.

## Base URL
```
https://api.crossref.org
```

## Polite Pool (Recommended)
Add an email via the `mailto` query param for faster, more reliable service:
```
?mailto=your@email.com
```

## Endpoints

### Search Works
```
GET /works?query={search}&rows={limit}
```

**Parameters:**
- `query` - Free text search
- `query.title` - Search titles only
- `query.author` - Search authors only
- `rows` - Results per page (max 1000)
- `offset` - Pagination offset
- `sort` - Sort field: `relevance`, `published`, `is-referenced-by-count`
- `order` - `asc` or `desc`

### Filter Syntax
```
?filter=from-pub-date:2024,type:journal-article
?filter=has-abstract:true
?filter=is-oa:true
?filter=publisher-name:Elsevier
```

### Get Work by DOI
```
GET /works/{doi}
```
Example: `/works/10.1038/nature12373`

### Get References (Citations Made)
```
GET /works/{doi}
```
Response includes a `reference` array with papers this work cites.

### Get Citations (Cited By)
```
GET /works?filter=references:{doi}
```
Find all works that cite a specific DOI.

### Search Journals
```
GET /journals?query={name}
GET /journals/{issn}
GET /journals/{issn}/works
```

### Search Funders
```
GET /funders?query={name}
GET /funders/{funder_id}/works
```

## Response Format

Works response:
```json
{
  "status": "ok",
  "message-type": "work-list",
  "message": {
    "total-results": 12345,
    "items": [
      {
        "DOI": "10.1038/nature12373",
        "title": ["Paper Title"],
        "author": [
          { "given": "John", "family": "Smith", "ORCID": "https://orcid.org/0000-0001-2345-6789" }
        ],
        "container-title": ["Nature"],
        "published": { "date-parts": [[2024, 3, 15]] },
        "type": "journal-article",
        "is-referenced-by-count": 42,
        "references-count": 35,
        "abstract": "<jats:p>Abstract text...</jats:p>",
        "URL": "http://dx.doi.org/10.1038/nature12373",
        "reference": [
          { "DOI": "10.1000/example", "key": "ref1", "unstructured": "..." }
        ]
      }
    ]
  }
}
```

## Example Code (codemode)

### Search for papers
```javascript
const query = encodeURIComponent('machine learning');
const res = await codemode.web_fetch({
  url: `https://api.crossref.org/works?query=${query}&rows=10&mailto=your@email.com`,
  format: 'json',
});
const { message } = JSON.parse(res.body);
return message.items.map((w) => ({
  doi: w.DOI,
  title: w.title?.[0] || 'Untitled',
  authors: w.author?.map((a) => `${a.given} ${a.family}`).join(', '),
  journal: w['container-title']?.[0],
  year: w.published?.['date-parts']?.[0]?.[0],
  citations: w['is-referenced-by-count'],
  type: w.type,
}));
```

### Get paper by DOI
```javascript
const doi = '10.1038/nature12373';
const res = await codemode.web_fetch({
  url: `https://api.crossref.org/works/${doi}`,
  format: 'json',
});
const { message } = JSON.parse(res.body);
return {
  title: message.title?.[0],
  abstract: message.abstract,
  citations: message['is-referenced-by-count'],
  references: message['references-count'],
};
```

### Get reference list (papers cited by a work)
```javascript
const res = await codemode.web_fetch({
  url: 'https://api.crossref.org/works/10.1038/nature12373',
  format: 'json',
});
const { message } = JSON.parse(res.body);
return (message.reference || []).map((r) => ({
  doi: r.DOI,
  text: r.unstructured || r['article-title'],
}));
```

### Find papers citing a DOI
```javascript
const doi = '10.1038/nature12373';
const res = await codemode.web_fetch({
  url: `https://api.crossref.org/works?filter=references:${doi}&rows=25`,
  format: 'json',
});
const { message } = JSON.parse(res.body);
return message.items.map((w) => ({
  doi: w.DOI,
  title: w.title?.[0],
  year: w.published?.['date-parts']?.[0]?.[0],
}));
```

### Filter by date and type
```javascript
const res = await codemode.web_fetch({
  url: 'https://api.crossref.org/works?filter=from-pub-date:2024,type:journal-article&rows=25',
  format: 'json',
});
```

## Rate Limits
- Without email: ~50 requests/second burst, lower sustained
- With email (polite pool): higher priority, better reliability
- Add `?mailto=email@example.com` to requests

## Work Types
- `journal-article` - Journal papers
- `book` - Books
- `book-chapter` - Book chapters
- `proceedings-article` - Conference papers
- `dataset` - Datasets
- `preprint` - Preprints

## Common Use Cases
- Resolve DOI to full metadata
- Get citation counts
- Find a paper's references
- Find papers that cite a specific work
- Search by author, title, or topic
- Filter by date, type, or open access

## Source-forward practice
CrossRef records are the authoritative link between a claim and its DOI — always render the
DOI as a clickable `https://doi.org/...` link in anything you show or write to a file.
When building citation lists or reference networks, preserve the full metadata (authors,
container title, date parts) so users can verify records rather than trusting a summary.
