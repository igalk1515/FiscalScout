# Evaluation · 2026-11-09 03:08 UTC

| Site | Crawl | Must-find | Precision@10 (documents) | Links decided by the LLM |
|---|---|---|---|---|
| Ann Arbor | done, 294 pages (`a65c5cee`) | 3/3 | 10/10 | 0 of 347 |
| Boerne ISD | done, 288 pages (`c05c81cc`) | 3/3 | 10/10 | 0 of 25 |
| Arizona State University | done, 292 pages (`2add4e1c`) | 3/3 | 7/10 | 0 of 45 |
| Bozeman | blocked, 0 pages (`ac021cd9`) | blocked and reported, as expected | - | - |

**Must-find recall: 9/9**

Precision@10 counts how many of the ten best-scored documents name a finance document (ACFR, budget, audit, financial report) in their link text, URL or the heading they sit under, and belong to the entity: documents on hosts listed as someone else's (the State of Arizona's budget office for ASU) never count. It is a quick check, not a full labeled set.

## Ann Arbor

- found: ACFR FY2025 (rank 1 of 24 acfr documents, score 0.73)
- found: Adopted budget FY2027 (ClearGov) or FY2026 (PDF) (rank 1 of 201 budget documents, score 0.95)
- found: Chief Financial Officer (Marti Praschan · Chief Financial Officer · mpraschan@a2gov.org · score 0.90)

Top 5 documents:
- 0.95 budget 2026 Adopted Budget FY2026 <https://www.a2gov.org/media/je4nrvnr/fy26-budget-book.pdf>
- 0.87 budget 2025 Adopted Budget FY2025 <https://media-001-us.cdn.govstack.com/a2gov-002-us/media/swaherth/budget-book-fy25.pdf>
- 0.80 budget 2024 Adopted Budget FY2024 <https://media-001-us.cdn.govstack.com/a2gov-002-us/media/32hbju5e/budget-book-fy24-for-web.pdf>
- 0.73 acfr 2025 Fiscal Year 2025 <https://media-001-us.cdn.govstack.com/a2gov-002-us/media/v2abzw2u/city-of-ann-arbor-6-30-25-acfr-final.pdf>
- 0.72 budget 2023 Adopted Budget FY2023 <https://media-001-us.cdn.govstack.com/a2gov-002-us/media/o4vouf2j/budget-book-for-web-fy23.pdf>

## Boerne ISD

- found: Annual Financial Report FY2025 (rank 1 of 5 acfr documents, score 0.92)
- found: Adopted budget 2026-27 (rank 1 of 9 budget documents, score 0.98)
- found: Chief Financial Officer (Wesley Scott · Chief Financial Officer · wesley.scott@boerneisd.net · score 0.85)

Top 5 documents:
- 0.98 budget 2027 2026-27 Adopted Budget <https://files.smartsites.parentsquare.com/13370/2026-2027_bisd_adopted_budget.pdf>
- 0.98 budget 2026 2025-26 Adopted Budget <https://files.smartsites.parentsquare.com/13370/2025-2026_bisd_adopted_budget.pdf>
- 0.92 acfr 2025 .pdf 2026-07-26 Annual Financial Report: June 30, 2025 <https://files.smartsites.parentsquare.com/13370/2025acfrfinal.pdf>
- 0.90 budget 2025 2024-25 Adopted Budget <https://files.smartsites.parentsquare.com/13370/2024-2025_bisd_adopted_budget.pdf>
- 0.84 acfr 2024 .pdf 2026-07-26 Annual Financial Report: June 30, 2024 <https://files.smartsites.parentsquare.com/13370/final-acfrye2024.pdf>

## Arizona State University

- found: ACFR 2026 (rank 1 of 8 acfr documents, score 0.68)
- found: Operating budget FY2027 (Board of Regents SharePoint) (rank 7 of 15 budget documents, score 0.60)
- found: Executive Vice President, Treasurer and CFO (Morgan R. Olsen · Executive Vice President, Treasurer and CFO · no email · score 0.63)

Top 5 documents:
- 0.71 budget 2027 FY 2027 Executive Budget Summary <https://ospb.az.gov/sites/default/files/2026-01/executive-budget-summary-fy-2027.pdf> (not the entity's)
- 0.71 budget 2026 FY 2026 Executive Budget Summary <https://ospb.az.gov/sites/default/files/2026-01/FY%202026%20Budget%20Summary.pdf> (not the entity's)
- 0.70 budget 2028 FY 2028 Legislative Budget Request — ABS <https://www.asu.edu/pb/documents/FY28-LBR.pdf>
- 0.70 budget 2027 FY 2027 Legislative Budget Request — ABS <https://www.asu.edu/pb/documents/FY27-LBR.pdf>
- 0.70 budget 2026 FY 2026 Legislative Budget Request — ABS <https://www.asu.edu/pb/documents/FY26-LBR.pdf>

## Bozeman

- the site refused automated requests (HTTP 403); not bypassed
