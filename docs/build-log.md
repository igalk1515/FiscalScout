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

## Steps 7 and 9 · Storage and the crawler

Built together, because the crawler is what writes the storage. `test/crawler.test.ts` runs a
real crawl against a fake city site served locally, on the test database:

- robots.txt: the disallowed page is skipped and never requested; robots.txt is fetched once.
- Politeness: with 3 workers, the site never saw two requests at once (`maxActive = 1`).
- Traps: the far-future calendar and the repeating path are recorded as skipped traps and never
  requested. Social links are not even queued.
- Retries: a 503 is retried and succeeds on the second attempt; a 404 fails once, no retry.
- Redirects: followed, final URL stored.
- Ranking with provenance: the ACFR (FY2025, heading "Annual Comprehensive Financial Report
  (ACFR)") and the FY2026 budget score at least 0.7, joined to the page and heading they came from.
- An opaque URL (`/DocumentCenter/View/77`) is learned to be a PDF when fetched.
- Contact: Jane Doe, Finance Director, jdoe@example.gov.
- Events: one `page.fetched` per page done, `crawl.started`, `crawl.done`.
- A second crawl of the same site adds no rows to `links` and keeps its own `link_scores`.
- An idempotency key returns the same crawl.
- A site that answers 403 is marked `blocked` after two requests (robots.txt and the start
  page), with the reason, and is not bypassed.

Bug found by the tests: the robots.txt cache keyed hosts without the port, so two servers on
127.0.0.1 shared rules. Hosts now include a non-default port, as RFC 9309 expects.

`npm test`: 75 tests pass.

## Step 8 milestone · one page end to end through the API

`POST /v1/crawls` with `max_depth: 0` on Ann Arbor's Financial Reporting page, then
`GET /v1/links?min_score=0.7`: FY2026 budget PDF 1.00, FY2027 budget (ClearGov) 0.95, FY2025
budget 0.92, FY2024 0.84, ACFR FY2025 0.78, each with the heading it was found under.
`/docs` renders the OpenAPI page. `test/api.test.ts` covers validation, idempotency, filters,
keyset pagination, full-text search, contacts, the pages list and the SSE stream.

## Step 10 · Live view

- `GET /v1/crawls/:id/events` streams history, then live events; `Last-Event-ID` resumes.
- Found while testing: events only reached streams in the same process, so a crawl started
  from the CLI did not update the API's watch page live. Events now also go out on a Postgres
  NOTIFY channel. Checked with `curl -N` against the API while the CLI crawled Ann Arbor:
  `page.fetching`, `page.fetched`, `page.skipped`, `contact.found` and `stats` arrived live.

## Step 9 on the real sites · first run, and what it taught

`npm run crawl:test-sites` (depth 3, 300 pages each), rules only:

- Bozeman: blocked after one refused request, reported, not bypassed.
- Ann Arbor: ACFR FY2025, the budgets and Marti Praschan found. Problem: "FY27 Budget
  Responses" memos scored as high as the budget itself.
- Boerne: reports, budgets and Wesley Scott found. Problems: the 2026-27 budget took the
  sidebar label "Contact Us" as its heading and ranked below 2025-26; Wesley Scott was stored
  three times (two hosts, and once as "Wes").
- ASU: budget and Morgan R. Olsen found, ACFR missed. Two causes: the budget was spent on
  asuonline.asu.edu, whose "Finance" and "Accounting" degree pages look like finance pages; and
  cfo.asu.edu answered HTTP 429. The crawler kept one request at a time per host, but three
  workers were hitting three asu.edu subdomains at once, which share one rate limit.

Fixes:
- Politeness per site (registrable domain) instead of per host, with a backoff that doubles on
  429 or 503 (up to a minute) and halves on success. 429 no longer pauses a host.
- No host may use more than 30% of the page budget.
- Degree, course and student pages lose 0.30 path score; phrases such as "Financial Reports"
  or "Business and Finance" gain 0.40.
- Papers about a document ("responses", "hearing notice", "agenda") lose 0.20.
- A bold line used as a heading is added to the real heading instead of replacing it.
- One contact per person per crawl: same name, or same email under a shorter name.
- A line like "Prepared by: Tom Crawford, CFO" is read as Tom Crawford, not the name above it.

## More fixes from real crawls

- **Pauses that never ended.** A host paused in one crawl stayed paused for every later crawl,
  so a later ASU crawl never fetched its start page. Pauses now last 15 minutes, and a crawl
  whose remaining hosts all wait longer than 16 minutes ends with the reason instead of
  waiting forever.
- **One crawl, two runners.** The API server, when it started, resumed crawls that the CLI had
  just created, so both processes worked on them. A crawl now has a lease renewed every 1.5
  seconds; another process takes it over only when the lease is 30 seconds stale. Tested with
  two runners started on one crawl: one `crawl.started`.
- **Supporting papers still ranked high.** The sum of signals often went past 1, so a -0.20
  penalty disappeared in the cap. Multipliers now come after the cap: a paper about a document
  x0.6, older years x0.6-1.0. Ann Arbor's "FY27 Budget Responses" now rank below the budget books.
- **Contacts that were not people.** "ASU Research Park" and "Learning Enterprise" were read as
  names. Acronyms and organization words are rejected; titles taken from sentences are cleaned.
- **A long Retry-After.** ASU asked for a long pause after two 429s. It is honored (capped at
  10 minutes), and the crawl waits instead of giving up after 5 minutes.
- **Re-rank from disk.** `npm run rescore` re-ranks a crawl from the saved pages in seconds,
  without contacting the sites. This is the reason raw pages are kept.

## LLM tier against the real API

An OpenAI key was added to `.env` (ignored by git). `npm run analyze` on the saved ASU pages:

- The four ACFRs the rules left unsure (0.52-0.69) were confirmed as `acfr` by the LLM. At
  first all four came back as 1.00, losing the year order, so the year and draft multipliers
  now apply after the LLM too.
- Morgan R. Olsen's contact was read by the LLM and passed the check against the page text.
- The strict JSON schema was accepted by `gpt-4o-mini`. Cost of the check: $0.0003.
