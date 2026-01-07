# CrossRef API

## Overview
The official DOI registry with metadata for 150M+ scholarly works. **No authentication required.**
Excellent for: DOI resolution, citation counts, reference lists, publisher metadata.

## Base URL
```
https://api.crossref.org
```

## Polite Pool (Recommended)
Add email to `User-Agent` or `mailto` query param for faster rate limits:
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
Response includes `reference` array with papers this work cites.

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
          {
            "given": "John",
            "family": "Smith",
            "ORCID": "https://orcid.org/0000-0001-2345-6789"
          }
        ],
        "container-title": ["Nature"],
        "published": {
          "date-parts": [[2024, 3, 15]]
        },
        "type": "journal-article",
        "is-referenced-by-count": 42,
        "references-count": 35,
        "abstract": "<jats:p>Abstract text...</jats:p>",
        "URL": "http://dx.doi.org/10.1038/nature12373",
        "license": [...],
        "reference": [
          {
            "DOI": "10.1000/example",
            "key": "ref1",
            "unstructured": "..."
          }
        ]
      }
    ]
  }
}
```

## Example Code

### Search for papers
```javascript
const query = encodeURIComponent('machine learning');
const res = await fetch(`https://api.crossref.org/works?query=${query}&rows=10`);
const { message } = await res.json();
log(`Found ${message['total-results']} results`);
return message.items.map(w => ({
  doi: w.DOI,
  title: w.title?.[0] || 'Untitled',
  authors: w.author?.map(a => `${a.given} ${a.family}`).join(', '),
  journal: w['container-title']?.[0],
  year: w.published?.['date-parts']?.[0]?.[0],
  citations: w['is-referenced-by-count'],
  type: w.type
}));
```

### Get paper by DOI
```javascript
const doi = '10.1038/nature12373';
const res = await fetch(`https://api.crossref.org/works/${doi}`);
const { message } = await res.json();
return {
  title: message.title?.[0],
  abstract: message.abstract,
  citations: message['is-referenced-by-count'],
  references: message['references-count']
};
```

### Get reference list (papers cited by a work)
```javascript
const doi = '10.1038/nature12373';
const res = await fetch(`https://api.crossref.org/works/${doi}`);
const { message } = await res.json();
return message.reference?.map(r => ({
  doi: r.DOI,
  text: r.unstructured || r['article-title']
})) || [];
```

### Find papers citing a DOI
```javascript
const doi = '10.1038/nature12373';
const res = await fetch(`https://api.crossref.org/works?filter=references:${doi}&rows=25`);
const { message } = await res.json();
log(`Found ${message['total-results']} citing papers`);
return message.items.map(w => ({
  doi: w.DOI,
  title: w.title?.[0],
  year: w.published?.['date-parts']?.[0]?.[0]
}));
```

### Filter by date and type
```javascript
const res = await fetch('https://api.crossref.org/works?filter=from-pub-date:2024,type:journal-article&rows=25');
const { message } = await res.json();
```

## Rate Limits
- Without email: ~50 requests/second burst, lower sustained
- With email (polite pool): Higher priority, better reliability
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
