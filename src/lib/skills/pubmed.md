# PubMed API (E-utilities)

## Overview
NCBI's biomedical literature database with 35M+ citations. **No authentication required** for basic use.
Excellent for: Medical research, clinical studies, biology, health sciences.

## Base URLs
```
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi  # Search
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi   # Fetch details
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi # Summaries
```

## Two-Step Process
1. **ESearch** - Search to get PMIDs (PubMed IDs)
2. **EFetch/ESummary** - Get details for those PMIDs

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

## EFetch (Get Full Records)
```
GET /efetch.fcgi?db=pubmed&id={pmid_list}&retmode=xml
```

## ESummary (Get Summaries - Simpler)
```
GET /esummary.fcgi?db=pubmed&id={pmid_list}&retmode=json
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
      "authors": [
        {"name": "Smith J", "authtype": "Author"}
      ],
      "source": "Nature Medicine",
      "volume": "30",
      "issue": "3",
      "pages": "123-456",
      "articleids": [
        {"idtype": "pubmed", "value": "39012345"},
        {"idtype": "doi", "value": "10.1038/example"}
      ],
      "pubtype": ["Journal Article", "Research Support, NIH"]
    }
  }
}
```

## Example Code

### Search and get summaries
```javascript
// Step 1: Search for PMIDs
const query = encodeURIComponent('machine learning radiology');
const searchRes = await fetch(
  `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${query}&retmax=10&retmode=json`
);
const { esearchresult } = await searchRes.json();
const pmids = esearchresult.idlist;
log(`Found ${esearchresult.count} results`);

if (pmids.length === 0) return [];

// Step 2: Get summaries
const summaryRes = await fetch(
  `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${pmids.join(',')}&retmode=json`
);
const { result } = await summaryRes.json();

return pmids.map(pmid => {
  const article = result[pmid];
  const doi = article.articleids?.find(a => a.idtype === 'doi')?.value;
  return {
    pmid,
    title: article.title,
    authors: article.authors?.slice(0, 3).map(a => a.name).join(', '),
    journal: article.source,
    pubdate: article.pubdate,
    doi,
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
  };
});
```

### Get paper by PMID
```javascript
const pmid = '39012345';
const res = await fetch(
  `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${pmid}&retmode=json`
);
const { result } = await res.json();
const article = result[pmid];
return {
  title: article.title,
  journal: article.source,
  pubdate: article.pubdate,
  authors: article.authors?.map(a => a.name)
};
```

### Search with date filter
```javascript
const query = encodeURIComponent('covid vaccine');
const res = await fetch(
  `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${query}&mindate=2024/01/01&maxdate=2024/12/31&datetype=pdat&retmax=20&retmode=json`
);
```

### Search by author
```javascript
const query = encodeURIComponent('Fauci A[Author]');
const res = await fetch(
  `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${query}&retmax=25&retmode=json`
);
```

### Search by MeSH term
```javascript
const query = encodeURIComponent('"Artificial Intelligence"[MeSH Terms]');
const res = await fetch(
  `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${query}&retmax=20&retmode=json`
);
```

### Get full abstract (XML parsing required)
```javascript
const pmid = '39012345';
const res = await fetch(
  `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmid}&retmode=xml`
);
const xml = await res.text();
const parser = new DOMParser();
const doc = parser.parseFromString(xml, 'text/xml');
const abstract = doc.querySelector('AbstractText')?.textContent;
```

## Rate Limits
- Without API key: 3 requests/second
- With API key: 10 requests/second
- Get free API key at: https://www.ncbi.nlm.nih.gov/account/

Add to requests: `&api_key=YOUR_KEY`

## Publication Types
- Journal Article
- Review
- Clinical Trial
- Meta-Analysis
- Randomized Controlled Trial
- Case Reports

## MeSH Terms (Common)
- "Machine Learning"
- "Artificial Intelligence"
- "Deep Learning"
- "Natural Language Processing"
- "Diagnosis, Computer-Assisted"

## Common Use Cases
- Search biomedical literature
- Find clinical studies on a topic
- Get article metadata by PMID
- Filter by date, author, or journal
- Find review articles or meta-analyses
