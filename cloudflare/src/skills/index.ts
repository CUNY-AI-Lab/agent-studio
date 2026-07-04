/**
 * Research/capability skills for the workspace agent.
 *
 * Each skill is a curated reference doc (an API cookbook, not a typed
 * connector) that the agent reads via the read_skill tool before using an
 * unfamiliar source. Docs live as markdown in ./docs/ — the source of truth —
 * and are bundled via the checked-in docs.generated.ts (regenerate with
 * `node scripts/build-skill-docs.mjs` after editing a doc).
 *
 * Skills without a doc are description-only: read_skill returns the
 * description and the model works from general knowledge of the API.
 *
 * Ported from the legacy Next.js app's src/lib/skills. Not carried over:
 * pdf/xlsx/docx/pptx (Python-dependent; no Python on Workers) and
 * worldcat/libguides (OAuth client-credential flows not yet wired) — see
 * PLAN.md.
 */

import { SKILL_DOCS } from './docs.generated';

export interface Skill {
  name: string;
  description: string;
}

export const SKILLS: Skill[] = [
  {
    name: 'openalex',
    description:
      "Search scholarly papers, journal articles, and academic publications. Returns: title, authors, publication year, citation count, DOI, open access status. Example queries: 'find papers about climate change', 'research articles on neural networks', 'who published about CRISPR in 2023'. No auth required.",
  },
  {
    name: 'crossref',
    description:
      "DOI registry with 150M+ scholarly works. Get citation counts, reference lists, and publisher metadata. Resolve DOIs to full metadata, find papers citing a specific work. Example queries: 'get metadata for this DOI', 'what papers cite this article', 'find references in this paper'. No auth required.",
  },
  {
    name: 'semantic-scholar',
    description:
      "AI-powered academic search with TLDR summaries and paper recommendations. Get citation contexts, author profiles, influential citations. Strong for AI/ML papers. Example queries: 'find highly-cited ML papers', 'get AI summary of this paper', 'recommend papers similar to this'. No auth required.",
  },
  {
    name: 'arxiv',
    description:
      "Open-access preprints for physics, math, CS, and AI/ML. Get latest research before peer review. Search by category (cs.LG, cs.CL), author, or topic. Returns: title, abstract, authors, PDF link, categories. Example queries: 'latest ML papers', 'find transformer papers', 'search cs.AI preprints'. No auth required.",
  },
  {
    name: 'pubmed',
    description:
      "NCBI's biomedical literature database with 35M+ citations. Search medical/clinical research, biology, health sciences. Filter by MeSH terms, publication type, date. Example queries: 'clinical trials for diabetes', 'AI in radiology studies', 'COVID vaccine research'. No auth required.",
  },
  {
    name: 'primo',
    description:
      "Search CUNY OneSearch / library catalog via Ex Libris Primo API. Find books, e-books, journals, articles available at CUNY libraries. Check availability, get call numbers, find items at specific campuses. Example queries: 'search CUNY library for machine learning books', 'does CUNY have this ISBN', 'find books at Graduate Center library'.",
  },
  {
    name: 'unpaywall',
    description:
      "Find free/open access versions of scholarly articles by DOI. Check if a paper has a free PDF available. Returns OA status, PDF links, publisher info. Example queries: 'is there a free version of this paper', 'find open access PDF for this DOI', 'check OA status'. No auth required.",
  },
  {
    name: 'wikipedia',
    description:
      "Search Wikipedia and get article content, summaries, and metadata. Useful for background research, definitions, and general knowledge. Example queries: 'what is quantum computing', 'get Wikipedia summary of machine learning', 'search Wikipedia for climate change'. No auth required.",
  },
  {
    name: 'nyc-opendata',
    description:
      "Access NYC Open Data via Socrata API. Thousands of datasets on NYC demographics, transportation, housing, crime, 311 calls, permits, inspections. Example queries: 'NYC restaurant inspections', '311 complaints by zip code', 'building permits in Brooklyn', 'subway ridership'. No auth required.",
  },
  {
    name: 'census',
    description:
      "Access US Census Bureau data including demographics, economic indicators, housing, and population statistics. American Community Survey (ACS), Decennial Census. Example queries: 'population of NYC', 'median income by zip code', 'housing data for Manhattan'. API key optional.",
  },
  {
    name: 'citation',
    description:
      "Format citations in various styles (APA 7, MLA 9, Chicago, BibTeX, RIS). Convert between formats. Build bibliographies from DOIs or metadata. Example queries: 'format this paper as APA citation', 'convert these DOIs to BibTeX', 'create a bibliography in Chicago style'. No auth required.",
  },
  {
    name: 'frontend-design',
    description:
      'Design guidelines for building polished UI components. Use when creating custom preview panels or HTML interfaces.',
  },
  {
    name: 'leaflet',
    description:
      "Create interactive maps in preview panels. Use for: location visualization, markers, popups, shapes, GeoJSON. Example queries: 'show these locations on a map', 'plot coordinates', 'create a map of NYC'.",
  },
  {
    name: 'threejs',
    description:
      "Create interactive 3D visualizations using Three.js. Render 3D scenes, bar charts, scatter plots, globes in preview panels with mouse controls. Example queries: 'create a 3D bar chart', 'visualize this data in 3D', 'show a rotating globe'. No auth required.",
  },
  {
    name: 'network-graph',
    description:
      "Create interactive network/graph visualizations using D3 force simulation. Show relationships, connections, hierarchies. Nodes and links with physics-based layout. Example queries: 'visualize citation network', 'show author collaborations', 'create a knowledge graph'. No auth required.",
  },
];

export function getSkill(name: string): Skill | null {
  return SKILLS.find((skill) => skill.name === name) ?? null;
}

/**
 * Full reference content for a skill: the bundled doc when one exists,
 * otherwise the description (the model works from general API knowledge).
 */
export function getSkillContent(name: string): string | null {
  const skill = getSkill(name);
  if (!skill) return null;
  const doc = SKILL_DOCS[name];
  return doc ?? `# ${skill.name}\n\n${skill.description}`;
}

/** Compact one-skill-per-line index for the system prompt. */
export function skillsPromptIndex(): string {
  return SKILLS.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n');
}
