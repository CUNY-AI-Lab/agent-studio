# Semantic Scholar API

## Overview
AI-powered academic search from Allen Institute for AI. **No authentication required** for basic use.
Excellent for: Paper recommendations, citation contexts, author profiles, AI/NLP research.

Make requests from codemode with `codemode.web_fetch({ url, format: 'json' })` — direct
`fetch()` is blocked. Parse the string body with `JSON.parse(res.body)`.

## Base URL
```
https://api.semanticscholar.org/graph/v1
```

## Rate Limits
- Without API key: 100 requests / 5 min — pace bulk work accordingly and back off on HTTP 429
- (Keyed access exists but this deployment uses the unauthenticated tier)

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

### Get Paper References / Citations
```
GET /paper/{paper_id}/references?fields={fields}&limit={limit}
GET /paper/{paper_id}/citations?fields={fields}&limit={limit}
```

### Search Authors
```
GET /author/search?query={name}
GET /author/{author_id}?fields={fields}
GET /author/{author_id}/papers?fields={fields}&limit={limit}
```

### Paper Recommendations
```
GET /recommendations/v1/papers/forpaper/{paper_id}
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
authorId, name, affiliations, homepage, paperCount, citationCount, hIndex
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
      "openAccessPdf": { "url": "https://arxiv.org/pdf/1706.03762" },
      "authors": [{ "authorId": "1234567", "name": "Ashish Vaswani" }],
      "fieldsOfStudy": ["Computer Science"],
      "tldr": { "text": "A new architecture based solely on attention..." }
    }
  ]
}
```

## Example Code (codemode)

### Search for papers
```javascript
const query = encodeURIComponent('transformer neural network');
const fields = 'paperId,title,year,citationCount,authors,isOpenAccess,tldr';
const res = await codemode.web_fetch({
  url: `https://api.semanticscholar.org/graph/v1/paper/search?query=${query}&limit=10&fields=${fields}`,
  format: 'json',
});
const { total, data } = JSON.parse(res.body);
return data.map((p) => ({
  id: p.paperId,
  title: p.title,
  year: p.year,
  citations: p.citationCount,
  authors: p.authors?.map((a) => a.name).join(', '),
  openAccess: p.isOpenAccess,
  summary: p.tldr?.text,
}));
```

### Get paper by DOI or arXiv ID
```javascript
const res = await codemode.web_fetch({
  url: 'https://api.semanticscholar.org/graph/v1/paper/DOI:10.1038/nature12373?fields=title,abstract,year,citationCount,authors',
  format: 'json',
});
const paper = JSON.parse(res.body);

// By arXiv ID:
// .../paper/ARXIV:2106.09685?fields=title,abstract,tldr
```

### Get citations of a paper
```javascript
const paperId = '649def34f8be52c8b66281af98ae884c09aef38b';
const res = await codemode.web_fetch({
  url: `https://api.semanticscholar.org/graph/v1/paper/${paperId}/citations?fields=title,year,citationCount,authors&limit=50`,
  format: 'json',
});
const { data } = JSON.parse(res.body);
return data.map((c) => c.citingPaper);
// References work the same way via /references, with entries under .citedPaper
```

### Search author and get papers
```javascript
const authorRes = await codemode.web_fetch({
  url: 'https://api.semanticscholar.org/graph/v1/author/search?query=Yann+LeCun',
  format: 'json',
});
const authorId = JSON.parse(authorRes.body).data[0].authorId;

const papersRes = await codemode.web_fetch({
  url: `https://api.semanticscholar.org/graph/v1/author/${authorId}/papers?fields=title,year,citationCount&limit=50`,
  format: 'json',
});
const { data: papers } = JSON.parse(papersRes.body);
return papers.sort((a, b) => b.citationCount - a.citationCount);
```

### Filter by year and field of study
```javascript
const query = encodeURIComponent('large language models');
const res = await codemode.web_fetch({
  url: `https://api.semanticscholar.org/graph/v1/paper/search?query=${query}&year=2023-2024&fieldsOfStudy=Computer+Science&limit=20&fields=title,year,citationCount`,
  format: 'json',
});
```

### Get paper recommendations
```javascript
const paperId = '649def34f8be52c8b66281af98ae884c09aef38b';
const res = await codemode.web_fetch({
  url: `https://api.semanticscholar.org/recommendations/v1/papers/forpaper/${paperId}?fields=title,year,citationCount&limit=10`,
  format: 'json',
});
const { recommendedPapers } = JSON.parse(res.body);
```

## Fields of Study
Computer Science, Medicine, Biology, Physics, Chemistry, Mathematics, Psychology,
Economics, Political Science, Sociology, Engineering, Environmental Science

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
- Find an author's top papers by impact

## Source-forward practice
TLDRs are machine-generated — present them as such, and always pair them with the paper's
DOI or arXiv link and its Semantic Scholar `paperId` so users can read the actual abstract.
In citation-network artifacts, keep external IDs on every node so each edge traces back to
a verifiable record.
