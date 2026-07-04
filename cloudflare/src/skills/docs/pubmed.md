# PubMed API (E-utilities)

## Overview
NCBI's biomedical literature database with 35M+ citations. **No authentication required** for basic use.
Excellent for: Medical research, clinical studies, biology, health sciences.

Make requests from codemode with `codemode.web_fetch({ url, format })` — direct `fetch()`
is blocked. Prefer the JSON endpoints (`retmode=json`); parse with `JSON.parse(res.body)`.
For the XML-only EFetch endpoint use `format: 'text'` and the regex shown below — there is
no `DOMParser` in the sandbox.

## Base URLs
```
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi  # Search
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi   # Fetch full records (XML)
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi # Summaries (JSON)
```

## Two-Step Process
1. **ESearch** - Search to get PMIDs (PubMed IDs)
2. **ESummary/EFetch** - Get details for those PMIDs

## ESearch (Search)
```
GET /esearch.fcgi?db=pubmed&term={query}&retmax={limit}&retmode=json
```

**Parameters:**
- `db` - Database (always `pubmed`)
- `term` - Search query
- `retmax` - Max results (default 20, max 10000)
- `retstart` - Offset for pagination
- `retmode` - `json` or `xml`
- `sort` - `relevance`, `pub_date`, `first_author`
- `datetype` - `pdat` (publication), `edat` (entry)
- `mindate`, `maxdate` - Date range (YYYY/MM/DD)

## Search Query Syntax

### Field Tags
- `[Title]` - Title only
- `[Author]` - Author name
- `[Abstract]` - Abstract text
- `[MeSH Terms]` - Medical Subject Headings
- `[Publication Type]` - Article type
- `[Journal]` - Journal name
- `[Date - Publication]` - Pub date

### Boolean Operators
- `AND`, `OR`, `NOT`

### Examples
```
diabetes[Title] AND treatment[Abstract]
Smith J[Author] AND cancer[MeSH Terms]
("2024"[Date - Publication])
```

## ESummary (Get Summaries - preferred, JSON)
```
GET /esummary.fcgi?db=pubmed&id={pmid_list}&retmode=json
```

## EFetch (Full Records - XML only)
```
GET /efetch.fcgi?db=pubmed&id={pmid_list}&retmode=xml
```

## Response Formats

### ESearch Response (JSON)
```json
{
  "esearchresult": {
    "count": "12345",
    "retmax": "20",
    "idlist": ["39012345", "39012344", "39012343"]
  }
}
```

### ESummary Response (JSON)
```json
{
  "result": {
    "uids": ["39012345"],
    "39012345": {
      "uid": "39012345",
      "pubdate": "2024 Mar",
      "title": "Article Title",
      "authors": [{ "name": "Smith J", "authtype": "Author" }],
      "source": "Nature Medicine",
      "volume": "30",
      "issue": "3",
      "pages": "123-456",
      "articleids": [
        { "idtype": "pubmed", "value": "39012345" },
        { "idtype": "doi", "value": "10.1038/example" }
      ],
      "pubtype": ["Journal Article", "Research Support, NIH"]
    }
  }
}
```

## Example Code (codemode)

### Search and get summaries
```javascript
// Step 1: Search for PMIDs
const query = encodeURIComponent('machine learning radiology');
const searchRes = await codemode.web_fetch({
  url: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${query}&retmax=10&retmode=json`,
  format: 'json',
});
const { esearchresult } = JSON.parse(searchRes.body);
const pmids = esearchresult.idlist;
if (pmids.length === 0) return [];

// Step 2: Get summaries
const summaryRes = await codemode.web_fetch({
  url: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${pmids.join(',')}&retmode=json`,
  format: 'json',
});
const { result } = JSON.parse(summaryRes.body);

return pmids.map((pmid) => {
  const article = result[pmid];
  const doi = article.articleids?.find((a) => a.idtype === 'doi')?.value;
  return {
    pmid,
    title: article.title,
    authors: article.authors?.slice(0, 3).map((a) => a.name).join(', '),
    journal: article.source,
    pubdate: article.pubdate,
    doi,
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
  };
});
```

### Search with date filter
```javascript
const query = encodeURIComponent('covid vaccine');
const res = await codemode.web_fetch({
  url: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${query}&mindate=2024/01/01&maxdate=2024/12/31&datetype=pdat&retmax=20&retmode=json`,
  format: 'json',
});
```

### Search by author or MeSH term
```javascript
// Author: term=Fauci A[Author]
// MeSH:   term="Artificial Intelligence"[MeSH Terms]
const query = encodeURIComponent('"Artificial Intelligence"[MeSH Terms]');
const res = await codemode.web_fetch({
  url: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${query}&retmax=20&retmode=json`,
  format: 'json',
});
```

### Get full abstract (EFetch XML, regex extraction)
```javascript
const pmid = '39012345';
const res = await codemode.web_fetch({
  url: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmid}&retmode=xml`,
  format: 'text',
});
const parts = [...res.body.matchAll(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g)];
const abstract = parts.map((m) => m[1].replace(/<[^>]+>/g, '').trim()).join('\n');
```

## Rate Limits
- 3 requests/second without an API key — this deployment runs unkeyed, so pace bulk
  lookups (batch PMIDs into one ESummary call instead of looping single requests)

## Publication Types
Journal Article, Review, Clinical Trial, Meta-Analysis, Randomized Controlled Trial, Case Reports

## MeSH Terms (Common)
"Machine Learning", "Artificial Intelligence", "Deep Learning",
"Natural Language Processing", "Diagnosis, Computer-Assisted"

## Common Use Cases
- Search biomedical literature
- Find clinical studies on a topic
- Get article metadata by PMID
- Filter by date, author, or journal
- Find review articles or meta-analyses

## Source-forward practice
Medical claims demand traceability: attach the PMID, the PubMed URL
(`https://pubmed.ncbi.nlm.nih.gov/{pmid}/`), and the DOI link to every result you present.
Note publication type (RCT vs. case report vs. review) alongside findings, and point users
to the records themselves rather than paraphrasing clinical conclusions without citations.
