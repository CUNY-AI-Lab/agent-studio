# Citation Formatting

Format citations from metadata (CrossRef, OpenAlex, PubMed, Primo records). Always include
the DOI as a clickable `https://doi.org/...` link when one is available, in every style.

## APA 7

**Journal article:**
> Smith, J. A., & Lee, R. (2024). Deep learning for citation analysis. *Journal of Informetrics*, *18*(2), 101–115. https://doi.org/10.1234/example

**Book:**
> Smith, J. A. (2023). *Machine learning foundations* (2nd ed.). MIT Press.

**Webpage:**
> Smith, J. A. (2024, March 15). *Understanding transformers*. Example Blog. https://example.com/transformers

## MLA 9

**Journal article:**
> Smith, Jane A., and Robert Lee. "Deep Learning for Citation Analysis." *Journal of Informetrics*, vol. 18, no. 2, 2024, pp. 101–115, https://doi.org/10.1234/example.

**Book:**
> Smith, Jane A. *Machine Learning Foundations*. 2nd ed., MIT Press, 2023.

**Webpage:**
> Smith, Jane A. "Understanding Transformers." *Example Blog*, 15 Mar. 2024, example.com/transformers.

## Chicago (Author-Date)

**Journal article:**
> Smith, Jane A., and Robert Lee. 2024. "Deep Learning for Citation Analysis." *Journal of Informetrics* 18 (2): 101–115. https://doi.org/10.1234/example.

**Book:**
> Smith, Jane A. 2023. *Machine Learning Foundations*. 2nd ed. Cambridge, MA: MIT Press.

**Webpage:**
> Smith, Jane A. 2024. "Understanding Transformers." Example Blog. March 15, 2024. https://example.com/transformers.

## BibTeX

```bibtex
@article{smith2024deep,
  author  = {Smith, Jane A. and Lee, Robert},
  title   = {Deep Learning for Citation Analysis},
  journal = {Journal of Informetrics},
  year    = {2024},
  volume  = {18},
  number  = {2},
  pages   = {101--115},
  doi     = {10.1234/example}
}

@book{smith2023foundations,
  author    = {Smith, Jane A.},
  title     = {Machine Learning Foundations},
  edition   = {2},
  publisher = {MIT Press},
  year      = {2023}
}
```

## RIS

```ris
TY  - JOUR
AU  - Smith, Jane A.
AU  - Lee, Robert
TI  - Deep Learning for Citation Analysis
JO  - Journal of Informetrics
PY  - 2024
VL  - 18
IS  - 2
SP  - 101
EP  - 115
DO  - 10.1234/example
UR  - https://doi.org/10.1234/example
ER  -
```

Common RIS types: `JOUR` (journal article), `BOOK` (book), `CHAP` (book chapter),
`CONF` (conference paper), `ELEC` (webpage).

## Practical notes

- Build citations from the source record's metadata (CrossRef `message`, OpenAlex work,
  PubMed ESummary) rather than from memory — check author order, year, volume/issue, pages.
- CrossRef titles arrive as arrays (`title[0]`) and dates as `date-parts`; normalize before formatting.
- Offer BibTeX or RIS as a downloadable file (via `ui_download` or a workspace file) when
  the user is collecting more than a few references.
- When a DOI exists, always render it as a link (`https://doi.org/{doi}`); fall back to a
  stable URL (PubMed, arXiv, catalog permalink) only when there is no DOI.
