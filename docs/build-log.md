# Build log

Each build step from the design ends with a check that was run and read before moving on.
This file records the check and what it printed.

## Step 1 · Project skeleton

- `docker compose up -d db`, then `npm run migrate`
- Result: `applied: 001_init.sql`. `\dt` in psql lists contacts, crawl_events, crawls, frontier,
  hosts, link_scores, links, llm_cache, pages, schema_migrations, sightings.
- The `scraper_test` database exists for the automated tests.
- Choice made while building: plain SQL migrations and the `pg` driver instead of Drizzle. The
  crawler's queries (SKIP LOCKED claims, upserts, keyset pagination) are raw SQL anyway, and a
  reviewer can read the schema in one file.

## Step 2 · Fetch one URL politely

- `npm test`: 30 tests pass, including the RFC 9309 examples (named group, `*` group, longest
  match, allow wins a tie, `*` and `$`, case-insensitive user-agent, Crawl-delay, 4xx means allow
  all, 5xx or no answer means disallow all) and the fetcher (redirects, loop, size cap, timeout,
  no download of non-HTML bodies, 4xx final versus 5xx retryable, Retry-After).
- `npm run fetch-one` on the four test sites:

| Site | robots.txt | Page |
|---|---|---|
| a2gov.org | rules, allowed | 200, 70,759 bytes, 512 ms |
| bozeman.net | 403, so allow all per RFC 9309 | redirect to www.bozemanmt.gov, then **403: blocked** |
| asu.edu | rules, allowed | 200, 77,183 bytes, 57 ms |
| boerneisd.net | rules, allowed | 200, 285,903 bytes, 479 ms |

## Step 3 · Extract links with anchor, heading and nearby text

- `test/extract.test.ts` runs on pages saved from the test sites (`test/fixtures`).
- Ann Arbor's Financial Reporting page: "Fiscal Year 2025" comes out with the heading
  "Annual Comprehensive Financial Report (ACFR)". The site hides a zero-width space inside
  "Annual"; the extractor removes it.
- Found while building: ASU renders its leadership cards from JSON inside the page, so
  Morgan R. Olsen is not in the HTML. The extractor now reads that JSON ("data islands") for
  links and text, which works without a browser. ClearGov's viewer is detected as an empty app
  shell (`thin`), so it is flagged `needs_browser`.

## Step 4 · Rules scoring with configurable keywords

`npm run analyze -- <saved page> --url <original url>` prints every score with its reason.

| Page | Result |
|---|---|
| Ann Arbor Financial Reporting | FY2026 budget PDF 0.99, FY2027 budget (ClearGov) 0.94, ACFR FY2025 0.77, ahead of older years |
| Ann Arbor Finance page | "Poverty Exemptions" below 0.2 |
| Boerne Annual Financial Reports | FY2025 final 0.91 ranks first; FY2023 draft marked and lowered to 0.64 |
| Boerne Adopted Budgets | 2026-27 budget = FY2027, 0.99; the Excel version counts as a document |
| ASU home | footer "Jobs" (cfo.asu.edu) has the best path score, from `cfo` in the host name |
| ASU Financial Reports | ACFR 2026 ranks first (0.69, unsure, so the LLM would confirm it) |
| ASU Operating Budget | "FY 2027" on SharePoint ranks first, from the bold line above the list |

Fixes made after reading real pages: a bold line alone in a paragraph counts as a heading;
screen-reader-only headings ("Breadcrumb") are ignored; SharePoint `/:b:/` links are PDFs; a
full official name in the link text counts more than a short word; list items take the text
before the list as context, not their neighbour's link.

## Step 5 · Contacts and file details

| Site | Contact found (rules only, no LLM) |
|---|---|
| Ann Arbor | Marti Praschan, Chief Financial Officer, mpraschan@a2gov.org, 734.794.6500 x45100 |
| Boerne | Wesley Scott (CPA, RTSBA kept out of the name), Chief Financial Officer, wesley.scott@boerneisd.net (from the mailto link) |
| ASU | Morgan R. Olsen, Executive Vice President, Treasurer and CFO, no email |

## Step 6 · LLM tier

- Off when there is no `OPENAI_API_KEY`; nothing calls out and rules decide.
- Tests with a fake API: strict JSON schema requested, answer validated, cached (the second
  call is free), a bad answer or an HTTP 500 returns null so the rules score stays, unknown
  document types are dropped and scores clamped. A contact the LLM returns is checked against
  the page text, and an invented email is dropped.
- Not yet run against the real API: there is no key on this machine.

`npm test`: 62 tests pass.
