---
name: citation
description: Format citations in various styles (APA 7, MLA 9, Chicago, BibTeX, RIS). Convert between formats. Build bibliographies from DOIs or metadata. Example queries: 'format this paper as APA citation', 'convert these DOIs to BibTeX', 'create a bibliography in Chicago style'. No auth required.
---

# Citation Formatting

## Overview
Format citations and bibliographies in academic styles. Use with DOI metadata from CrossRef, OpenAlex, or Unpaywall.

## Supported Styles
- **APA 7** - American Psychological Association, 7th edition
- **MLA 9** - Modern Language Association, 9th edition
- **Chicago 17** - Chicago Manual of Style (author-date)
- **BibTeX** - LaTeX bibliography format
- **RIS** - Reference manager interchange format

## Citation Formatting Functions

### APA 7th Edition
```javascript
function formatAPA(work) {
  // work = { authors: [{given, family}], title, year, journal, volume, issue, pages, doi }

  // Authors: Last, F. M., & Last, F. M.
  let authorStr = '';
  if (work.authors && work.authors.length > 0) {
    if (work.authors.length === 1) {
      const a = work.authors[0];
      authorStr = `${a.family}, ${a.given ? a.given.charAt(0) + '.' : ''}`;
    } else if (work.authors.length === 2) {
      authorStr = work.authors.map(a =>
        `${a.family}, ${a.given ? a.given.charAt(0) + '.' : ''}`
      ).join(', & ');
    } else if (work.authors.length <= 20) {
      const last = work.authors[work.authors.length - 1];
      const rest = work.authors.slice(0, -1);
      authorStr = rest.map(a =>
        `${a.family}, ${a.given ? a.given.charAt(0) + '.' : ''}`
      ).join(', ') + ', & ' + `${last.family}, ${last.given ? last.given.charAt(0) + '.' : ''}`;
    } else {
      // 20+ authors: first 19, ..., last
      const first19 = work.authors.slice(0, 19);
      const last = work.authors[work.authors.length - 1];
      authorStr = first19.map(a =>
        `${a.family}, ${a.given ? a.given.charAt(0) + '.' : ''}`
      ).join(', ') + ', ... ' + `${last.family}, ${last.given ? last.given.charAt(0) + '.' : ''}`;
    }
  }

  // Title (sentence case for articles)
  const title = work.title;

  // Journal in italics (use * for markdown)
  const journal = work.journal ? `*${work.journal}*` : '';

  // Volume(issue), pages
  let volIssue = '';
  if (work.volume) {
    volIssue = `*${work.volume}*`;
    if (work.issue) volIssue += `(${work.issue})`;
  }
  if (work.pages) volIssue += `, ${work.pages}`;

  // DOI
  const doi = work.doi ? `https://doi.org/${work.doi}` : '';

  return `${authorStr} (${work.year}). ${title}. ${journal}, ${volIssue}. ${doi}`.trim();
}
```

### MLA 9th Edition
```javascript
function formatMLA(work) {
  // Authors: Last, First, and First Last.
  let authorStr = '';
  if (work.authors && work.authors.length > 0) {
    if (work.authors.length === 1) {
      const a = work.authors[0];
      authorStr = `${a.family}, ${a.given || ''}.`;
    } else if (work.authors.length === 2) {
      const [first, second] = work.authors;
      authorStr = `${first.family}, ${first.given || ''}, and ${second.given || ''} ${second.family}.`;
    } else {
      const first = work.authors[0];
      authorStr = `${first.family}, ${first.given || ''}, et al.`;
    }
  }

  // Title in quotes for articles
  const title = `"${work.title}."`;

  // Container (journal) in italics
  const journal = work.journal ? `*${work.journal}*,` : '';

  // vol. X, no. Y
  let volIssue = '';
  if (work.volume) volIssue += `vol. ${work.volume}`;
  if (work.issue) volIssue += `, no. ${work.issue}`;

  // Year
  const year = work.year ? `, ${work.year}` : '';

  // Pages
  const pages = work.pages ? `, pp. ${work.pages}` : '';

  // DOI
  const doi = work.doi ? `. https://doi.org/${work.doi}` : '';

  return `${authorStr} ${title} ${journal} ${volIssue}${year}${pages}${doi}`.trim();
}
```

### Chicago 17 (Author-Date)
```javascript
function formatChicago(work) {
  // Authors: Last, First, and First Last
  let authorStr = '';
  if (work.authors && work.authors.length > 0) {
    if (work.authors.length === 1) {
      const a = work.authors[0];
      authorStr = `${a.family}, ${a.given || ''}`;
    } else if (work.authors.length === 2) {
      const [first, second] = work.authors;
      authorStr = `${first.family}, ${first.given || ''}, and ${second.given || ''} ${second.family}`;
    } else if (work.authors.length === 3) {
      const [first, second, third] = work.authors;
      authorStr = `${first.family}, ${first.given || ''}, ${second.given || ''} ${second.family}, and ${third.given || ''} ${third.family}`;
    } else {
      const first = work.authors[0];
      authorStr = `${first.family}, ${first.given || ''}, et al`;
    }
  }

  // Year after author
  const year = work.year ? `. ${work.year}` : '';

  // Title in quotes
  const title = `"${work.title}."`;

  // Journal in italics
  const journal = work.journal ? `*${work.journal}*` : '';

  // Volume, no. Issue: pages
  let volIssue = '';
  if (work.volume) {
    volIssue = ` ${work.volume}`;
    if (work.issue) volIssue += `, no. ${work.issue}`;
    if (work.pages) volIssue += `: ${work.pages}`;
  }

  // DOI
  const doi = work.doi ? `. https://doi.org/${work.doi}` : '';

  return `${authorStr}${year}. ${title} ${journal}${volIssue}${doi}`.trim();
}
```

### BibTeX Format
```javascript
function formatBibTeX(work) {
  // Generate citation key: AuthorYear
  const firstAuthor = work.authors?.[0]?.family || 'Unknown';
  const key = `${firstAuthor.toLowerCase()}${work.year || ''}`;

  // Author string: Last, First and Last, First
  const authors = work.authors?.map(a =>
    `${a.family}, ${a.given || ''}`
  ).join(' and ') || '';

  const lines = [
    `@article{${key},`,
    `  author = {${authors}},`,
    `  title = {${work.title}},`,
  ];

  if (work.journal) lines.push(`  journal = {${work.journal}},`);
  if (work.year) lines.push(`  year = {${work.year}},`);
  if (work.volume) lines.push(`  volume = {${work.volume}},`);
  if (work.issue) lines.push(`  number = {${work.issue}},`);
  if (work.pages) lines.push(`  pages = {${work.pages}},`);
  if (work.doi) lines.push(`  doi = {${work.doi}},`);

  lines.push('}');
  return lines.join('\n');
}
```

### RIS Format
```javascript
function formatRIS(work) {
  const lines = ['TY  - JOUR'];  // Journal article

  if (work.authors) {
    work.authors.forEach(a => {
      lines.push(`AU  - ${a.family}, ${a.given || ''}`);
    });
  }

  if (work.title) lines.push(`TI  - ${work.title}`);
  if (work.journal) lines.push(`JO  - ${work.journal}`);
  if (work.year) lines.push(`PY  - ${work.year}`);
  if (work.volume) lines.push(`VL  - ${work.volume}`);
  if (work.issue) lines.push(`IS  - ${work.issue}`);
  if (work.pages) {
    const [start, end] = work.pages.split('-');
    if (start) lines.push(`SP  - ${start.trim()}`);
    if (end) lines.push(`EP  - ${end.trim()}`);
  }
  if (work.doi) lines.push(`DO  - ${work.doi}`);

  lines.push('ER  - ');  // End record
  return lines.join('\n');
}
```

## Get Metadata from DOI (via CrossRef)

```javascript
async function getWorkFromDOI(doi) {
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
  const res = await fetch(url);
  if (!res.ok) return null;

  const { message } = await res.json();

  return {
    title: message.title?.[0] || '',
    authors: message.author?.map(a => ({
      given: a.given,
      family: a.family
    })) || [],
    year: message.published?.['date-parts']?.[0]?.[0] ||
          message.created?.['date-parts']?.[0]?.[0],
    journal: message['container-title']?.[0] || '',
    volume: message.volume,
    issue: message.issue,
    pages: message.page,
    doi: message.DOI
  };
}
```

## Complete Example: DOI to All Formats

```javascript
// Get metadata
const doi = '10.1038/nature12373';
const work = await getWorkFromDOI(doi);

if (!work) {
  return 'Could not retrieve metadata for DOI';
}

// Format in all styles
const citations = {
  apa: formatAPA(work),
  mla: formatMLA(work),
  chicago: formatChicago(work),
  bibtex: formatBibTeX(work),
  ris: formatRIS(work)
};

// Display or return
await setMarkdown('citations', {
  title: 'Citations',
  content: `# ${work.title}

## APA 7
${citations.apa}

## MLA 9
${citations.mla}

## Chicago 17
${citations.chicago}

## BibTeX
\`\`\`bibtex
${citations.bibtex}
\`\`\`

## RIS
\`\`\`
${citations.ris}
\`\`\`
`
});

return citations;
```

## Batch Convert DOIs to Bibliography

```javascript
const dois = [
  '10.1038/nature12373',
  '10.1126/science.1234567'
];

const works = await Promise.all(
  dois.map(doi => getWorkFromDOI(doi))
);

// Create BibTeX file content
const bibtex = works
  .filter(w => w !== null)
  .map(formatBibTeX)
  .join('\n\n');

await download('references.bib', bibtex, 'text');

return `Created bibliography with ${works.filter(w => w).length} entries`;
```

## Common Use Cases
- Format individual citations for papers
- Create bibliographies from reference lists
- Convert between citation formats (BibTeX ↔ RIS)
- Export citations for Zotero/Mendeley import
- Build formatted reference sections

## Tips
- Use CrossRef API to get metadata from DOIs
- BibTeX keys should be unique (add a/b/c for same author+year)
- RIS format is widely supported for import into reference managers
- For books, use `@book` in BibTeX and `TY  - BOOK` in RIS
