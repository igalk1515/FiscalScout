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

## Step 11 · Evaluation

`npm run eval` against [eval/must-find.json](../eval/must-find.json), on the latest crawl that
started from each home page (depth 3, 300 pages):

| Site | Must-find, rules only | Must-find, with LLM | Precision@10 |
|---|---|---|---|
| Ann Arbor | 3/3 | 3/3 | 10/10 |
| Boerne ISD | 3/3 | 3/3 | 10/10 |
| ASU | 3/3 | 3/3 | 8/10 |
| Bozeman | blocked, reported | blocked, reported | - |

Both columns come from the same fetched pages: the crawl ran once with the LLM on, then
`npm run rescore` re-ranked it from disk with rules only, and again with the LLM from cache.

Two more fixes came out of reading the LLM results:
- With the LLM on, an older ACFR the LLM confirmed (0.84) outranked the newer one the rules were
  already sure about (0.73), because they were on two scales. Links the rules are sure about
  now count as confirmed and use the same scale. Test added that failed before the fix.
- The LLM confirmed "FY27 Budget Responses" and an RFP budget spreadsheet as budgets; the
  rules' discount for papers about a document now applies after the LLM too, and RFP, bid and
  addendum count as such papers.

LLM spend for the whole night: one crawl of the three sites, $0.025, plus checks under a cent.
Every rescore came from the cache (183 cached answers). `LLM_MAX_USD_PER_CRAWL` (default $0.50)
caps a crawl; a test checks that the LLM stops at the cap and the crawl finishes on rules.

## Step 12 · README

The README covers setup, how ranking works, API usage with real responses, the live view, the
data model, tests, known limits and the scale-out design. `docker compose build app` builds the
image; a container started from it answered `/health`, served the OpenAPI document (8 paths)
and the start page.

## Review after the build (Nov 8, afternoon)

Igal watched a new Boerne crawl in the live view and asked three questions. Each led to a fix.

- **Why was a host skipped for using its share of the budget?** Because Boerne's site answers
  under three host names (`boerneisd.net`, `www.boerneisd.net`, `boerneisd.smartsiteshost.com`)
  and the crawl read it three times: 201 fetches for 121 distinct pages. Content hashes did not
  catch it, since each copy prints its own host in the HTML. Every copy names the `www` URL as
  canonical, so the crawler now learns a mirror host from the first non-home page whose
  canonical is the same path on another in-scope host, and reads every later URL on it under
  the original host. Test: one site served as `127.0.0.1` and `localhost`; the copy is fetched
  once and no page twice.

  The first crawl with this fix showed a side effect. With the copies gone, the main site sat
  on one host and hit the 30% share of the budget at 90 pages; 161 of its pages were skipped,
  among them the purchasing and business services pages, and the budget went to elementary
  school sites. The main site (the seed's host, its redirect target, and the host a mirrored
  seed points to) is now exempt from the share, and links named for the office around a
  contact ("Purchasing", "Payroll") get a path score, so the crawl visits them.
- **Is the CFO the only contact?** No. The site also lists the assistant director of business
  services, the purchasing director and the payroll team. Contacts were kept only when their
  title matched the contact keywords exactly. Now a contact group can list `related` titles
  (business services, accounting, payroll, purchasing, budget...), and the score is relevance
  times completeness, so the CFO stays first and the office follows: leaders at 0.6 relevance,
  staff at 0.4. A related word counts only in a job title ("Payroll Manager", not a "Payroll"
  menu item). Fixes found on the way: a department mailbox next to a person (purchasing@) no
  longer stops the block from reaching that person's own email, and is never given to a person
  as their email; "Office of the State Treasurer" is the name of an office, not a title; a
  former CFO ranks far below the current one.
- **Failed pages should say they are broken links.** 404 and 410 now count as broken links,
  in a counter of their own, a list in the live view with the page each was found on, and
  `/v1/crawls/{id}/pages?status=broken`. Every counter in the live view explains itself on hover.

## Step 13 · Render tier

A headless browser for pages that arrive as an empty shell (`playwright-core`, driving a browser
already on the machine: Edge here, Chromium in the Docker image when built with
`WITH_BROWSER=1`). Off by default (`RENDER_JS`). Rules, all tested:

- only pages on the entity's own site that answered 200 and were flagged `needs_browser`;
- at most 20 per crawl; one visit holds the site's lease like a fetch;
- pages and data calls inside the browser are checked against robots.txt;
- images, fonts and styles are not loaded; at most 60 requests per page;
- a page that refused us is never opened; a bot-check page is reported and not used.

The first real run flagged Boerne's jobs site as a bot check: the page loads fully but carries
Imperva's monitoring script, and the check matched its name. A marker now counts only when the
page has almost no content of its own; a test covers the case. Rendered again, the page took
2.4 seconds and 48 requests and gave the three HR specialists with email and phone (with an
"HR specialist" contact keyword; the default keywords do not ask for HR).

Docker: the default image stays 346 MB; with the browser it is 1.48 GB, and a script-built page
renders inside the container.

An ASU crawl Igal started with the render tier on showed two wastes: policy.asu.edu was rendered
five times (many links redirect to it) and the single-sign-on page five more. Each page is now
rendered once, copies are not rendered, and sign-in pages never are; a test with a redirect to
a sign-in page checks it, and fails without the rule. A 429 inside the browser was reported and
not bypassed, as designed, and now also slows the crawl down. The crawl still found 3 of 3.

## Adjustable keywords and search (Nov 8, evening)

Igal pointed out that the brief asks for adjustable keyword prioritization, and the only way to
adjust keywords was a JSON body in the API; there was no way to search results from a page.

- The start page has a keyword editor: one card per group with kind, a weight slider, synonyms
  and, for contacts, related titles.
- `POST /v1/crawls/{id}/rescore` ranks a finished crawl again from its saved pages with new
  keywords, and keeps them on the crawl. Rules only by default, so it costs nothing; 10 to 40
  seconds for 300 pages. A test sets the budget weight to 0, checks that budgets drop out and
  the ACFR stays, then sets it back and gets the same budgets.
- A results page (`/results/{id}`) searches documents (words, keyword, type, year, score) and
  contacts (name, title or email; keyword group; score), and holds the keyword editor with a
  re-rank button.
- `/v1/contacts` takes `q` and `keyword`; a contact now records its keyword group next to the
  matched term, so "finance director" lists the whole finance office.

Writing the re-rank test found an older bug: a re-rank scored an opaque document URL
(`/DocumentCenter/View/77`) as a page again, losing what the crawl learned by fetching it. The
re-rank now keeps the file type the crawl learned.

## Final pass (Nov 8, night)

I read the brief once more against the code. Four gaps came up, and all four are now closed.

**1. The scale write-up was not where a reviewer would read it.**
- **Problem:** it lived in the HTML plan, which GitHub shows as source code.
- **Fix:** [scaling.md](scaling.md) replaces it, rewritten from the numbers the final test
  crawls measured. Those numbers include rows per page, the speed of one site and the raw page
  size, plus what would break first.

**2. A crawl could not be stopped.**
- **Problem:** earlier in the day one crawl had to be stopped by hand in the database.
- **Fix:** `POST /v1/crawls/{id}/cancel`, plus a Stop button on the watch page.
- **How a stop works:** the runner stops claiming, lets pages in flight finish, skips the rest
  of the queue and announces `crawl.cancelled` once. A runner in another process learns of the
  stop from its heartbeat. A cancelled status is final: a crawl that finishes at the same moment
  cannot overwrite it.
- **Tests:** a crawl runs in a second runner that shares only the database, and is stopped
  through the first runner's API. The test fails if the heartbeat check is removed.
- **A bug found in a real browser:** clicking Stop on the live server showed the watch page
  still counting queued pages after the stop. The final counters had gone out before the queue
  was skipped. The order is fixed, and a test checks it.

**3. ASU ranked the State of Arizona's budgets above its own.**
- **Problem:** `cfo.asu.edu` links the Governor's budget summaries on `ospb.az.gov`. They say
  "Budget" in the link text, so they scored 1.00 and took three of the top five places. ASU's
  own budget is labeled only "FY 2027", and it came sixth.
- **Fix:** a document on another government's site (`.gov`, `.mil`, state and local `.us`) now
  gets × 0.75, in the rules and again after the LLM. With the LLM, ASU's top 10 is now all its
  own documents, and the state's summaries come 11th and 12th. Ann Arbor's ranking did not
  change.
- **Also discounted:** the State of Arizona's 2021 single audit on `azauditor.gov`. It covers
  ASU, but it is the state's document. It stays in the list, lower down.
- **The eval was wrong in both directions.** Precision@10 matched only the link text, so it
  counted the state's summaries as hits and missed ASU's budgets. It now also reads the heading
  above each link. It never counts a host listed as someone else's
  ([must-find.json](../eval/must-find.json)).

**4. The results came from different crawls.** One of them was crawled with the browser on.

### The final run

One final run on the final code, with the default settings: depth 3, a page budget of 300,
`gpt-4o-mini`, and browser rendering off. Ann Arbor, Boerne and ASU were each crawled once,
then ranked twice, with the LLM and with rules alone.

| | With LLM | Rules only |
|---|---|---|
| Must-find | 9/9 | 9/9 |
| Precision@10 | 10/10 at all three sites | 10/10 at Ann Arbor and Boerne, 7/10 at ASU |
| LLM cost | $0.002 (mostly cache) | none |

Bozeman was reported as blocked.

**Why ASU is 7/10 with rules alone:** the state's two summaries still lead, at 0.71. ASU's own
ACFR scores 0.68 by rules, which is in the band that goes to the LLM, and the LLM is what lifts
it.

### Moved

The repository moved to `C:\Users\user\Desktop\peronProjects\high-value-link-scraper`.

The first attempt stopped halfway. The database container had the old `docker/initdb` folder
mounted, which blocked moving the folder in one step. The fix:
1. Stop the container. The data lives in a named volume, so it was not affected.
2. Move the remaining folders one by one.
3. Check that every folder's file count matches and that `git fsck` is clean.
4. Recreate the container from the new path.

All 19 crawls were still there afterwards.

## Learned weights (Nov 9–10)

The hand-set weights were the weakest part of the ranking: guesses, checked on four sites. This
step fits them on labeled links. The README section "Learned weights" has the method and the
final numbers; this is what happened on the way.

**Data.** 18 more public bodies (`eval/learn/sites.txt`) crawled with the LLM off, plus the
four test sites: 5,402 links with a keyword signal. The first dataset counted the same menu link
once per page, because its nearest heading changes from page to page: Ann Arbor alone gave 1,653
links. Deduplicating by URL and link text, preferring a sighting outside a menu, brought it to 408.

**Labels.** `gpt-4o-mini` labeled "FY27 Budget Responses" (answers to council questions) as the
budget itself. A stricter prompt fixed half of them: the same kind of link still got different
labels in different batches. `gpt-4.1-mini` labeled all of them consistently, so it labeled the
whole set: $0.43. A hand check of 60 random labels agreed on 58 (`eval/learn/handcheck.md`).

**First fit: better overall, worse at the top.** AUC rose from 0.88 to 0.93 on the first 12
sites, but precision@10 fell from 75/99 to 67/99. Ann Arbor's top 10 showed why: "FY2012 Budget
Impact Analysis" looked the same as "Adopted Budget FY2026" to the model. The keyword is in the
link text, it is a PDF, and it has a year. Two features fixed it:
- whether the link text is just the name and year, and how many other words it carries;
- whether the keyword is only near the link and not in its text or URL.

A bug in the first one hid the gain at first: it removed "budget" before "adopted budget",
leaving "adopted" as an extra word. With longer terms removed first, precision@10 went to 84/99.

**One site set the weights.** With all 22 sites, the gain shrank to 121/170 against 118/170.
Dane County has 476 department budget requests, labeled as budgets: a third of all targets, from
one site. Weighting every site the same in training brought it to 132/170 against 118/170.

**Measured fairly on the test sites.** Leave-one-site-out keeps each site out of its own model.
For the must-find list, a model was fitted on the 18 training sites only, then used to re-rank
the test crawls with the LLM off. Result: must-find 9/9, and ASU at 10/10 instead of 7/10.
ASU's own FY2027 budget and 2026 ACFR now lead, where the rules put the State of Arizona's
summaries first. The shipped model is then fitted on all 22 sites.

**Tests:** 173 pass. New tests cover the regression solver, the features, the ranker switch
through the API, and two sanity checks on the trained weights.

**Re-ranking on the demo server ran out of memory.** It held every saved page of a crawl in
memory at once; a 500-page Bozeman crawl was too much for a 450 MB service. It now reads pages
one at a time, after a quick pass over each page's head for mirror hosts. The dataset built
with the new reader is byte for byte the same.

## Bozeman joins the evaluation (Nov 10)

Bozeman had been in the must-find list only as "expect blocked". Since the request identity
change the crawler gets in, so it now has targets of its own. bozemanmt.gov answers 403 to curl
and to a headless browser, so the targets were read by hand from the crawler's saved copy of the
finance hub and the staff directory:
- the FY2025 annual financial report;
- the 2027 biennium adopted budget, the FY2027 recommended budget or the FY2026 adopted budget.
  The adopted biennium budget appeared on the hub between two crawls;
- the finance director, Melissa Hodnett.

A fresh crawl with the default settings (295 pages, LLM on, $0.0005), ranked three ways:

| | Rules only | With LLM | Learned |
|---|---|---|---|
| Must-find | 2/3 | 2/3 | 2/3 |
| Precision@10 | 9/10 | 9/10 | 9/10 |

Across the four sites, must-find is now 11 of 12 for every ranker.

**The miss is the finance director, for every ranker.** The directory is a table with "Hodnett,
Melissa", last name first, and no email. The contact extractor does not read that layout.

**A weakness of the learned ranker showed here.** It puts the FY2027 recommended budget third,
behind the capital improvement plan and the FY2024 budget. It reads "Recommended" and "Biennium"
as extra words in the link text, the same feature that pushes down "Budget Impact Analysis".
