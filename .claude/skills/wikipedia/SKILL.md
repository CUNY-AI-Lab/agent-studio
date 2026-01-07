---
name: wikipedia
description: Search Wikipedia and get article content, summaries, and metadata. Useful for background research, definitions, and general knowledge. Example queries: 'what is quantum computing', 'get Wikipedia summary of machine learning', 'search Wikipedia for climate change'. No auth required.
---

# Wikipedia / MediaWiki API

## Overview
Search Wikipedia and retrieve article content, summaries, and metadata.
**No authentication required.**

## Base URLs
```
https://en.wikipedia.org/w/api.php       # Action API
https://en.wikipedia.org/api/rest_v1     # REST API (simpler)
```

## REST API (Recommended for Simple Use)

### Get Page Summary
```
GET /api/rest_v1/page/summary/{title}
```

Returns a short summary, thumbnail, and basic info.

### Get Full Page HTML
```
GET /api/rest_v1/page/html/{title}
```

### Get Mobile-Optimized Summary
```
GET /api/rest_v1/page/mobile-sections/{title}
```

## Action API (More Powerful)

### Search Wikipedia
```
GET /w/api.php?action=query&list=search&srsearch={query}&format=json
```

**Parameters:**
- `srsearch` - Search query
- `srlimit` - Max results (default 10, max 500)
- `sroffset` - Pagination offset

### Get Page Content
```
GET /w/api.php?action=query&titles={title}&prop=extracts&exintro&format=json
```

**Parameters:**
- `exintro` - Only get intro section
- `explaintext` - Plain text instead of HTML

### Get Page Info + Links
```
GET /w/api.php?action=query&titles={title}&prop=info|links|categories&format=json
```

## Example Code

### Search Wikipedia
```javascript
const query = encodeURIComponent('machine learning');
const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${query}&srlimit=10&format=json&origin=*`;

const res = await fetch(url);
const data = await res.json();

return data.query.search.map(result => ({
  title: result.title,
  snippet: result.snippet.replace(/<[^>]*>/g, ''), // Strip HTML
  pageId: result.pageid,
  wordCount: result.wordcount,
  url: `https://en.wikipedia.org/wiki/${encodeURIComponent(result.title)}`
}));
```

### Get Page Summary (REST API)
```javascript
const title = 'Artificial_intelligence';
const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;

const res = await fetch(url);
const data = await res.json();

return {
  title: data.title,
  summary: data.extract,
  thumbnail: data.thumbnail?.source,
  url: data.content_urls.desktop.page,
  lastModified: data.timestamp
};
```

### Get Full Article Text
```javascript
const title = 'Climate_change';
const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=extracts&explaintext&format=json&origin=*`;

const res = await fetch(url);
const data = await res.json();
const pages = data.query.pages;
const page = Object.values(pages)[0];

return {
  title: page.title,
  content: page.extract,
  pageId: page.pageid
};
```

### Get Categories for a Page
```javascript
const title = 'New_York_City';
const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=categories&cllimit=50&format=json&origin=*`;

const res = await fetch(url);
const data = await res.json();
const page = Object.values(data.query.pages)[0];

return page.categories.map(c => c.title.replace('Category:', ''));
```

### Search and Get Summary in One
```javascript
async function wikiSearch(query) {
  // Search
  const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=5&format=json&origin=*`;
  const searchRes = await fetch(searchUrl);
  const searchData = await searchRes.json();

  // Get summaries for top results
  const results = await Promise.all(
    searchData.query.search.slice(0, 3).map(async result => {
      const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(result.title)}`;
      const summaryRes = await fetch(summaryUrl);
      const summary = await summaryRes.json();
      return {
        title: summary.title,
        summary: summary.extract,
        url: summary.content_urls?.desktop?.page
      };
    })
  );

  return results;
}

return await wikiSearch('quantum computing');
```

## Other Language Wikipedias
Replace `en.wikipedia.org` with:
- `es.wikipedia.org` - Spanish
- `fr.wikipedia.org` - French
- `de.wikipedia.org` - German
- `zh.wikipedia.org` - Chinese
- etc.

## Rate Limits
- No hard rate limit for reasonable use
- Add `User-Agent` header for heavy use
- Use `origin=*` for CORS in browser

## Common Use Cases
- Get background info on research topics
- Look up definitions and explanations
- Find related topics via categories/links
- Verify facts and get citations
- Build knowledge bases
