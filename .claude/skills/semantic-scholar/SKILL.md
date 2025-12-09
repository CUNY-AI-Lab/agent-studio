---
name: semantic-scholar
description: AI-powered academic search with TLDR summaries and paper recommendations. Get citation contexts, author profiles, influential citations. Strong for AI/ML papers. Example queries: 'find highly-cited ML papers', 'get AI summary of this paper', 'recommend papers similar to this'. No auth required.
---

# Semantic Scholar API

## Overview
AI-powered academic search from Allen Institute for AI. **No authentication required** for basic use.
Excellent for: Paper recommendations, citation contexts, author profiles, AI/NLP research.

## Base URL
```
https://api.semanticscholar.org/graph/v1
```

## Rate Limits
- Without API key: 100 requests/5 min
- With API key: 1 request/sec sustained

## Endpoints

### Search Papers
```
GET /paper/search?query={search}&limit={limit}
```

**Parameters:**
- `query` - Search terms
- `limit` - Results (1-100, default 10)
- `offset` - Pagination
- `fields` - Comma-separated field list
- `year` - Filter: `2024` or `2020-2024`
- `openAccessPdf` - Filter for open access
- `fieldsOfStudy` - e.g., `Computer Science`

### Get Paper Details
```
GET /paper/{paper_id}?fields={fields}
```

Paper IDs can be:
- Semantic Scholar ID: `649def34f8be52c8b66281af98ae884c09aef38b`
- DOI: `DOI:10.1038/nature12373`
- arXiv: `ARXIV:2106.09685`
- PMID: `PMID:19872477`
- CorpusId: `CorpusId:215416146`

### Get Paper References
```
GET /paper/{paper_id}/references?fields={fields}&limit={limit}
```

### Get Paper Citations
```
GET /paper/{paper_id}/citations?fields={fields}&limit={limit}
```

### Search Authors
```
GET /author/search?query={name}
```

### Get Author Details
```
GET /author/{author_id}?fields={fields}
GET /author/{author_id}/papers?fields={fields}&limit={limit}
```

### Paper Recommendations
```
GET /recommendations/v1/papers/forpaper/{paper_id}
POST /recommendations/v1/papers
```

## Field Options

**Paper fields:**
```
paperId, corpusId, url, title, abstract, venue, publicationVenue,
year, referenceCount, citationCount, influentialCitationCount,
isOpenAccess, openAccessPdf, fieldsOfStudy, s2FieldsOfStudy,
authors, citations, references, embedding, tldr
```

**Author fields:**
```
authorId, name, affiliations, homepage, paperCount, citationCount,
hIndex
```

## Response Format

Paper search response:
```json
{
  "total": 12345,
  "offset": 0,
  "data": [
    {
      "paperId": "649def34f8be52c8b66281af98ae884c09aef38b",
      "title": "Attention Is All You Need",
      "abstract": "The dominant sequence transduction models...",
      "year": 2017,
      "citationCount": 85000,
      "influentialCitationCount": 8500,
      "isOpenAccess": true,
      "openAccessPdf": {
        "url": "https://arxiv.org/pdf/1706.03762"
      },
      "authors": [
        {
          "authorId": "1234567",
          "name": "Ashish Vaswani"
        }
      ],
      "fieldsOfStudy": ["Computer Science"],
      "tldr": {
        "text": "A new architecture based solely on attention..."
      }
    }
  ]
}
```

## Example Code

### Search for papers
```javascript
const query = encodeURIComponent('transformer neural network');
const fields = 'paperId,title,year,citationCount,authors,isOpenAccess,tldr';
const res = await fetch(
  `https://api.semanticscholar.org/graph/v1/paper/search?query=${query}&limit=10&fields=${fields}`
);
const { total, data } = await res.json();
log(`Found ${total} papers`);
return data.map(p => ({
  id: p.paperId,
  title: p.title,
  year: p.year,
  citations: p.citationCount,
  authors: p.authors?.map(a => a.name).join(', '),
  openAccess: p.isOpenAccess,
  summary: p.tldr?.text
}));
```

### Get paper by DOI
```javascript
const doi = '10.1038/nature12373';
const fields = 'title,abstract,year,citationCount,referenceCount,authors,isOpenAccess';
const res = await fetch(
  `https://api.semanticscholar.org/graph/v1/paper/DOI:${doi}?fields=${fields}`
);
const paper = await res.json();
```

### Get paper by arXiv ID
```javascript
const arxivId = '2106.09685';
const res = await fetch(
  `https://api.semanticscholar.org/graph/v1/paper/ARXIV:${arxivId}?fields=title,abstract,tldr`
);
const paper = await res.json();
```

### Get citations of a paper
```javascript
const paperId = '649def34f8be52c8b66281af98ae884c09aef38b';
const fields = 'title,year,citationCount,authors';
const res = await fetch(
  `https://api.semanticscholar.org/graph/v1/paper/${paperId}/citations?fields=${fields}&limit=50`
);
const { data } = await res.json();
return data.map(c => ({
  title: c.citingPaper.title,
  year: c.citingPaper.year,
  citations: c.citingPaper.citationCount
}));
```

### Get references of a paper
```javascript
const paperId = '649def34f8be52c8b66281af98ae884c09aef38b';
const fields = 'title,year,authors';
const res = await fetch(
  `https://api.semanticscholar.org/graph/v1/paper/${paperId}/references?fields=${fields}&limit=50`
);
const { data } = await res.json();
return data.map(r => r.citedPaper);
```

### Search author and get papers
```javascript
// Find author
const authorRes = await fetch(
  'https://api.semanticscholar.org/graph/v1/author/search?query=Yann+LeCun'
);
const { data: authors } = await authorRes.json();
const authorId = authors[0].authorId;

// Get their papers
const papersRes = await fetch(
  `https://api.semanticscholar.org/graph/v1/author/${authorId}/papers?fields=title,year,citationCount&limit=50`
);
const { data: papers } = await papersRes.json();
return papers.sort((a, b) => b.citationCount - a.citationCount);
```

### Filter by year and field
```javascript
const query = encodeURIComponent('large language models');
const res = await fetch(
  `https://api.semanticscholar.org/graph/v1/paper/search?query=${query}&year=2023-2024&fieldsOfStudy=Computer+Science&limit=20&fields=title,year,citationCount`
);
const { data } = await res.json();
```

### Get paper recommendations
```javascript
const paperId = '649def34f8be52c8b66281af98ae884c09aef38b';
const res = await fetch(
  `https://api.semanticscholar.org/recommendations/v1/papers/forpaper/${paperId}?fields=title,year,citationCount&limit=10`
);
const { recommendedPapers } = await res.json();
```

## Fields of Study
- Computer Science
- Medicine
- Biology
- Physics
- Chemistry
- Mathematics
- Psychology
- Economics
- Political Science
- Sociology
- Engineering
- Environmental Science

## Unique Features
- **TLDR**: AI-generated one-sentence summaries
- **Influential Citations**: Citations that meaningfully build on the work
- **Paper Embeddings**: Vector representations for similarity
- **Recommendations**: ML-based related paper suggestions

## Common Use Cases
- Find highly-cited papers in a field
- Get AI summaries (TLDR) of papers
- Discover related work via recommendations
- Build citation networks
- Find author's top papers by impact
