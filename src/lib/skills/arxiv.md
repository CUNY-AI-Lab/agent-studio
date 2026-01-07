# arXiv API

## Overview
Open-access preprint server for physics, math, CS, and more. **No authentication required.**
Excellent for: Latest research, preprints, AI/ML papers, physics, mathematics.

## Base URL
```
https://export.arxiv.org/api/query
```

## Search Endpoint
```
GET /api/query?search_query={query}&start={offset}&max_results={limit}
```

## Search Query Syntax

### Field Prefixes
- `all:` - All fields
- `ti:` - Title
- `au:` - Author
- `abs:` - Abstract
- `co:` - Comment
- `jr:` - Journal reference
- `cat:` - Category
- `id:` - arXiv ID

### Boolean Operators
- `AND`, `OR`, `ANDNOT`
- Parentheses for grouping

### Examples
```
ti:attention+AND+abs:transformer
au:hinton+AND+cat:cs.LG
all:large+language+models
```

## Parameters
- `search_query` - Query string with field prefixes
- `id_list` - Comma-separated arXiv IDs (e.g., `2106.09685,1706.03762`)
- `start` - Offset for pagination (default 0)
- `max_results` - Results per page (default 10, max 30000)
- `sortBy` - `relevance`, `lastUpdatedDate`, `submittedDate`
- `sortOrder` - `ascending`, `descending`

## Categories

### Computer Science
- `cs.AI` - Artificial Intelligence
- `cs.CL` - Computation and Language (NLP)
- `cs.CV` - Computer Vision
- `cs.LG` - Machine Learning
- `cs.NE` - Neural and Evolutionary Computing
- `cs.IR` - Information Retrieval

### Statistics
- `stat.ML` - Machine Learning

### Mathematics
- `math.ST` - Statistics Theory

### Physics
- `physics.comp-ph` - Computational Physics
- `quant-ph` - Quantum Physics

## Response Format (Atom XML)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <totalResults>12345</totalResults>
  <startIndex>0</startIndex>
  <itemsPerPage>10</itemsPerPage>
  <entry>
    <id>http://arxiv.org/abs/2106.09685v1</id>
    <updated>2021-06-17T17:59:59Z</updated>
    <published>2021-06-17T17:59:59Z</published>
    <title>LoRA: Low-Rank Adaptation of Large Language Models</title>
    <summary>Abstract text here...</summary>
    <author>
      <name>Edward J. Hu</name>
    </author>
    <link href="http://arxiv.org/abs/2106.09685v1" rel="alternate" type="text/html"/>
    <link href="http://arxiv.org/pdf/2106.09685v1" rel="related" type="application/pdf"/>
    <arxiv:primary_category term="cs.CL"/>
    <category term="cs.CL"/>
    <category term="cs.LG"/>
  </entry>
</feed>
```

## Example Code

### Search for papers
```javascript
const query = encodeURIComponent('ti:transformer AND abs:attention');
const res = await fetch(
  `https://export.arxiv.org/api/query?search_query=${query}&max_results=10&sortBy=submittedDate&sortOrder=descending`
);
const xml = await res.text();

// Parse XML
const parser = new DOMParser();
const doc = parser.parseFromString(xml, 'text/xml');
const entries = doc.querySelectorAll('entry');

const papers = Array.from(entries).map(entry => {
  const id = entry.querySelector('id')?.textContent?.split('/abs/')[1];
  return {
    arxivId: id?.replace(/v\d+$/, ''),
    title: entry.querySelector('title')?.textContent?.trim(),
    abstract: entry.querySelector('summary')?.textContent?.trim(),
    authors: Array.from(entry.querySelectorAll('author name')).map(n => n.textContent),
    published: entry.querySelector('published')?.textContent,
    pdfUrl: `https://arxiv.org/pdf/${id}`,
    categories: Array.from(entry.querySelectorAll('category')).map(c => c.getAttribute('term'))
  };
});
return papers;
```

### Get paper by arXiv ID
```javascript
const arxivId = '2106.09685';
const res = await fetch(
  `https://export.arxiv.org/api/query?id_list=${arxivId}`
);
const xml = await res.text();
const parser = new DOMParser();
const doc = parser.parseFromString(xml, 'text/xml');
const entry = doc.querySelector('entry');
return {
  title: entry.querySelector('title')?.textContent?.trim(),
  abstract: entry.querySelector('summary')?.textContent?.trim(),
  pdfUrl: `https://arxiv.org/pdf/${arxivId}.pdf`
};
```

### Search by category
```javascript
const query = encodeURIComponent('cat:cs.LG');
const res = await fetch(
  `https://export.arxiv.org/api/query?search_query=${query}&max_results=20&sortBy=submittedDate&sortOrder=descending`
);
```

### Search by author
```javascript
const author = encodeURIComponent('au:lecun');
const res = await fetch(
  `https://export.arxiv.org/api/query?search_query=${author}&max_results=25`
);
```

### Get multiple papers by ID
```javascript
const ids = '2106.09685,1706.03762,1810.04805';
const res = await fetch(
  `https://export.arxiv.org/api/query?id_list=${ids}`
);
```

## Helper: Parse arXiv Response
```javascript
function parseArxivResponse(xml) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');

  const total = doc.querySelector('totalResults')?.textContent;
  const entries = doc.querySelectorAll('entry');

  const papers = Array.from(entries).map(entry => {
    const idUrl = entry.querySelector('id')?.textContent;
    const arxivId = idUrl?.split('/abs/')[1]?.replace(/v\d+$/, '');

    return {
      arxivId,
      title: entry.querySelector('title')?.textContent?.replace(/\s+/g, ' ').trim(),
      abstract: entry.querySelector('summary')?.textContent?.trim(),
      authors: Array.from(entry.querySelectorAll('author name')).map(n => n.textContent),
      published: entry.querySelector('published')?.textContent?.split('T')[0],
      updated: entry.querySelector('updated')?.textContent?.split('T')[0],
      pdfUrl: `https://arxiv.org/pdf/${arxivId}.pdf`,
      htmlUrl: `https://arxiv.org/abs/${arxivId}`,
      categories: Array.from(entry.querySelectorAll('category')).map(c => c.getAttribute('term'))
    };
  });

  return { total: parseInt(total || '0'), papers };
}
```

## Rate Limits
- No strict limits, but be courteous
- Wait 3 seconds between requests for bulk operations
- Use `id_list` for multiple specific papers

## Common Use Cases
- Find latest AI/ML preprints
- Get paper metadata and PDFs
- Search by author or topic
- Browse specific categories (cs.LG, cs.CL)
- Track research trends before peer review
