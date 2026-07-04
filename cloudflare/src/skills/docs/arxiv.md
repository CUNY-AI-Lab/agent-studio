# arXiv API

## Overview
Open-access preprint server for physics, math, CS, and more. **No authentication required.**
Excellent for: Latest research, preprints, AI/ML papers, physics, mathematics.

The API returns Atom XML. Fetch it from codemode with
`codemode.web_fetch({ url, format: 'text' })` (direct `fetch()` is blocked) and parse the
`body` string. There is no `DOMParser` in the sandbox — use the regex helper below.

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

### Other
- `stat.ML` - Machine Learning (Statistics)
- `math.ST` - Statistics Theory
- `physics.comp-ph` - Computational Physics
- `quant-ph` - Quantum Physics

## Response Format (Atom XML)

```xml
<feed xmlns="http://www.w3.org/2005/Atom">
  <totalResults>12345</totalResults>
  <startIndex>0</startIndex>
  <itemsPerPage>10</itemsPerPage>
  <entry>
    <id>http://arxiv.org/abs/2106.09685v1</id>
    <published>2021-06-17T17:59:59Z</published>
    <title>LoRA: Low-Rank Adaptation of Large Language Models</title>
    <summary>Abstract text here...</summary>
    <author><name>Edward J. Hu</name></author>
    <link href="http://arxiv.org/pdf/2106.09685v1" rel="related" type="application/pdf"/>
    <category term="cs.CL"/>
    <category term="cs.LG"/>
  </entry>
</feed>
```

## Helper: Parse arXiv Response (no DOMParser in the sandbox)

```javascript
function parseArxivFeed(xml) {
  const totalMatch = xml.match(/<opensearch:totalResults[^>]*>(\d+)|<totalResults[^>]*>(\d+)/);
  const total = parseInt(totalMatch?.[1] || totalMatch?.[2] || '0', 10);

  const entries = xml.split('<entry>').slice(1).map((chunk) => {
    const tag = (name) => {
      const m = chunk.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
      return m ? m[1].replace(/\s+/g, ' ').trim() : null;
    };
    const idUrl = tag('id') || '';
    const versioned = idUrl.split('/abs/')[1];
    const arxivId = versioned?.replace(/v\d+$/, '');
    return {
      arxivId,
      title: tag('title'),
      abstract: tag('summary'),
      authors: [...chunk.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => m[1].trim()),
      published: tag('published')?.split('T')[0],
      updated: tag('updated')?.split('T')[0],
      pdfUrl: arxivId ? `https://arxiv.org/pdf/${arxivId}` : null,
      htmlUrl: arxivId ? `https://arxiv.org/abs/${arxivId}` : null,
      categories: [...chunk.matchAll(/<category[^>]*term="([^"]+)"/g)].map((m) => m[1]),
    };
  });

  return { total, papers: entries };
}
```

## Example Code (codemode)

### Search for papers
```javascript
const query = encodeURIComponent('ti:transformer AND abs:attention');
const res = await codemode.web_fetch({
  url: `https://export.arxiv.org/api/query?search_query=${query}&max_results=10&sortBy=submittedDate&sortOrder=descending`,
  format: 'text',
});
return parseArxivFeed(res.body).papers;
```

### Get paper(s) by arXiv ID
```javascript
const res = await codemode.web_fetch({
  url: 'https://export.arxiv.org/api/query?id_list=2106.09685,1706.03762',
  format: 'text',
});
const { papers } = parseArxivFeed(res.body);
```

### Search by category (latest first)
```javascript
const res = await codemode.web_fetch({
  url: 'https://export.arxiv.org/api/query?search_query=cat:cs.LG&max_results=20&sortBy=submittedDate&sortOrder=descending',
  format: 'text',
});
```

### Search by author
```javascript
const res = await codemode.web_fetch({
  url: `https://export.arxiv.org/api/query?search_query=${encodeURIComponent('au:lecun')}&max_results=25`,
  format: 'text',
});
```

## Rate Limits
- No strict limits, but be courteous
- Wait ~3 seconds between requests for bulk operations
- Use `id_list` to fetch multiple specific papers in one request

## Common Use Cases
- Find latest AI/ML preprints
- Get paper metadata and PDF links
- Search by author or topic
- Browse specific categories (cs.LG, cs.CL)
- Track research trends before peer review

## Source-forward practice
Always cite preprints by their arXiv ID and link to the abstract page
(`https://arxiv.org/abs/{id}`), noting that they may not be peer-reviewed. Keep the ID,
version, and categories attached to results in any artifact you generate so readers land
on the record itself, not just your summary of it.
