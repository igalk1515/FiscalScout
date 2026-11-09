# Evaluation · 2026-11-09 03:07 UTC

| Site | Crawl | Must-find | Precision@10 (documents) | Links decided by the LLM |
|---|---|---|---|---|
| Ann Arbor | done, 294 pages (`a65c5cee`) | 3/3 | 10/10 | 225 of 318 |
| Boerne ISD | done, 288 pages (`c05c81cc`) | 3/3 | 10/10 | 6 of 23 |
| Arizona State University | done, 292 pages (`2add4e1c`) | 3/3 | 10/10 | 23 of 31 |
| Bozeman | blocked, 0 pages (`ac021cd9`) | blocked and reported, as expected | - | - |

**Must-find recall: 9/9**

Precision@10 counts how many of the ten best-scored documents name a finance document (ACFR, budget, audit, financial report) in their link text, URL or the heading they sit under, and belong to the entity: documents on hosts listed as someone else's (the State of Arizona's budget office for ASU) never count. It is a quick check, not a full labeled set.

## Ann Arbor

- found: ACFR FY2025 (rank 1 of 24 acfr documents, score 0.92)
- found: Adopted budget FY2027 (ClearGov) or FY2026 (PDF) (rank 1 of 173 budget documents, score 1.00)
- found: Chief Financial Officer (Marti Praschan · Chief Financial Officer · mpraschan@a2gov.org · score 0.90)

Top 5 documents:
- 1.00 budget 2026 Adopted Budget FY2026 <https://www.a2gov.org/media/je4nrvnr/fy26-budget-book.pdf>
- 0.92 acfr 2025 Fiscal Year 2025 <https://media-001-us.cdn.govstack.com/a2gov-002-us/media/v2abzw2u/city-of-ann-arbor-6-30-25-acfr-final.pdf>
- 0.92 single audit 2025 Fiscal Year 2025 <https://media-001-us.cdn.govstack.com/a2gov-002-us/media/ebznvooc/city-of-ann-arbor-6-30-25-saac-final.pdf>
- 0.92 budget 2025 Adopted Budget FY2025 <https://media-001-us.cdn.govstack.com/a2gov-002-us/media/swaherth/budget-book-fy25.pdf>
- 0.84 acfr 2024 Fiscal Year 2024 <https://media-001-us.cdn.govstack.com/a2gov-002-us/media/ae2lvwvx/city-of-ann-arbor-6-30-24-acfr-final-1.pdf>

## Boerne ISD

- found: Annual Financial Report FY2025 (rank 1 of 5 acfr documents, score 0.92)
- found: Adopted budget 2026-27 (rank 1 of 8 budget documents, score 1.00)
- found: Chief Financial Officer (Wesley Scott · Chief Financial Officer · wesley.scott@boerneisd.net · score 0.85)

Top 5 documents:
- 1.00 budget 2027 2026-27 Adopted Budget <https://files.smartsites.parentsquare.com/13370/2026-2027_bisd_adopted_budget.pdf>
- 1.00 budget 2027 2026-27 Adopted Budget (Interactive) <https://files.smartsites.parentsquare.com/13370/2026-2027-1.xlsx>
- 1.00 budget 2026 2025-26 Adopted Budget <https://files.smartsites.parentsquare.com/13370/2025-2026_bisd_adopted_budget.pdf>
- 0.92 budget 2025 2024-25 Adopted Budget <https://files.smartsites.parentsquare.com/13370/2024-2025_bisd_adopted_budget.pdf>
- 0.92 acfr 2025 .pdf 2026-07-26 Annual Financial Report: June 30, 2025 <https://files.smartsites.parentsquare.com/13370/2025acfrfinal.pdf>

## Arizona State University

- found: ACFR 2026 (rank 1 of 8 acfr documents, score 1.00)
- found: Operating budget FY2027 (Board of Regents SharePoint) (rank 1 of 11 budget documents, score 0.90)
- found: Executive Vice President, Treasurer and CFO (Morgan R. Olsen · Executive Vice President, Treasurer and CFO · no email · score 0.63)

Top 5 documents:
- 1.00 acfr 2026 Annual comprehensive financial report 2026 <https://www.asu.edu/fs/documents/annual_reports/ASU-2026-Annual-comp-fin-rpt.pdf>
- 0.92 acfr 2025 Annual comprehensive financial report 2025 <https://www.asu.edu/fs/documents/annual_reports/ASU-2025-Annual-comp-fin-rpt.pdf>
- 0.90 budget 2027 FY 2027 <https://azregents.sharepoint.com/:b:/s/ABORPublic/Committee/Board/IQDqzHYxINVCRIodPTa5Q03nAY1bAil0wGE2sT3teJ6TJn0>
- 0.90 budget 2026 FY 2026 <https://azregents.sharepoint.com/:b:/s/ABORPublic/Committee/Board/EbogOvp7kjRKkGs3-JcNcb0B3aFqSzxlH5GyXSb-06F8CA>
- 0.85 budget 2028 FY 2028 Legislative Budget Request — ABS <https://www.asu.edu/pb/documents/FY28-LBR.pdf>

## Bozeman

- the site refused automated requests (HTTP 403); not bypassed
