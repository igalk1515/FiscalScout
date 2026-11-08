# High-Value Link Scraper

Finds the links on a public entity's website that lead to **budgets, annual financial reports
(ACFR) and finance contacts**, ranks them, and serves them through an API, with a live view of
every crawl.

- **Ranks every link** with weighted rules and keywords you set per crawl. An LLM decides only
  the links the rules are unsure about, and the system runs fine without one.
- **Pulls out contacts and files as results:** a finance contact comes out as name, title, email
  and phone, each checked against the page text. A file comes out with its document type and
  fiscal year.
- **Crawls politely and with focus:** robots.txt (RFC 9309), one request at a time per host,
  trap guards, and the most promising link first, so a page budget lands on the finance pages.
- **Keeps provenance:** every link records every page it was found on, with the anchor text,
  the heading above it and the nearby text, and the reason for its score.
- **REST API** with OpenAPI docs, keyset pagination and one error shape, plus a
  Server-Sent Events stream and a watch page that shows each crawl live.

The design behind it, including the version for millions of pages a day, is in
[docs/design.html](docs/design.html). How each build step was checked is in
[docs/build-log.md](docs/build-log.md).

---

## Results on the test sites

RESULTS_TABLE

---

## Setup

You need Docker. Node 20.12 or newer (22 recommended) is only needed to run outside Docker.

### Everything in Docker

```bash
docker compose up --build
```

Open http://localhost:3000, pick a test site, press **Crawl**, and watch it live. The API docs
are at http://localhost:3000/docs.

An LLM key is optional. Without it, everything runs on rules alone:

```bash
OPENAI_API_KEY=sk-... docker compose up --build
```

### Local development

```bash
docker compose up -d db          # Postgres 16 on localhost:5433
npm install
npm run migrate                  # creates the tables
npm run dev                      # API on http://localhost:3000
npm run crawl:test-sites         # crawls the four test sites, prints a summary
npm run eval                     # must-find recall and precision for the test sites
npm test                         # unit and integration tests (needs the db container)
```

Other commands:

| Command | What it does |
|---|---|
| `npm run fetch-one -- <url>` | Robots decision, status, final URL, size and time for one URL |
| `npm run analyze -- <url>` | Ranks one page without a database and prints the reason for every score |
| `npm run analyze -- page.html --url <original url>` | The same, offline, on a saved page |
| `npm run crawl -- <url> --depth 3 --budget 300` | One crawl from the command line |
| `npm run rescore -- <crawl-id> [--llm]` | Re-rank a finished crawl from the saved pages, without fetching (after a rule change) |

Settings (all optional) are in [.env.example](.env.example): `OPENAI_API_KEY`, `OPENAI_MODEL`,
`LLM_MAX_USD_PER_CRAWL`, `CRAWL_WORKERS`, `MIN_HOST_DELAY_MS`, `DATABASE_URL`, `RAW_DIR`.

---

## How links are prioritized

### Two scores per link

| Score | Question | Used for |
|---|---|---|
| **Target score** | Is this link itself a result: the budget, the ACFR, the finance contact page? | Sorting results |
| **Path score** | Does this link lead to results? | Ordering the crawl queue |

"Departments" has a target score near 0 and a good path score. "FY2026 Adopted Budget (PDF)"
has a high target score and a path score of 0, because documents are results, not pages to
crawl.

### Rule signals (target score)

The score is a weighted sum, clipped to 0–1. Every score is stored with the list of signals
that produced it.

| Signal | Example | Weight |
|---|---|---|
| Keyword in the link text | "FY2026 Adopted Budget" | +0.35 × keyword weight (+0.45 for a full name of 3+ words) |
| Keyword in the URL, file name or title attribute | `/fy26-budget-book.pdf`, `2025acfrfinal.pdf` | +0.25 × weight |
| Keyword in the heading above the link | "Annual Comprehensive Financial Report (ACFR)" | +0.15 × weight |
| Keyword in the nearby text | | +0.10 × weight |
| The link text is only a year, under a heading that names the target | "Fiscal Year 2025" | +0.20 × weight |
| Document file | PDF, Excel, Word; SharePoint `/:b:/` links count as PDF | +0.15 |
| A page on another platform named for the document | ClearGov budget viewer | +0.10 |
| A page on the entity's own site named for a document | usually the list of documents | −0.15 |
| Found on a page with a high path score | | +0.10 × parent's path score |
| Draft | `acfr-2023_draft.pdf` | −0.15 |
| A paper about the document | "FY27 Budget Responses", hearing notices, agendas | −0.20 |
| In a menu, header or footer | | −0.20 |
| Fiscal year | FY2025 when FY2027 is in progress | × 0.6–1.0 |
| Noise | social networks, login, calendars, news, images | score 0 |

The fiscal year comes from the strongest pattern found: "June 30, 2025" or "6-30-25", then
"FY2026" or "Fiscal Year 2025", then "2025-26" (named by the end year), then a bare year.

### Path score

Keyword in the link text (+0.40 × weight), in the URL or **host name** (+0.30 × weight, which is
how `cfo.asu.edu` behind a footer link called "Jobs" gets picked up), finance hub words such as
finance, budget, transparency or treasurer (+0.25), navigation words such as departments or
documents (+0.12), and 0.15 × the parent page's path score.

### Keywords are set per crawl

```json
{
  "url": "https://www.a2gov.org/",
  "keywords": {
    "acfr":             { "weight": 1.0, "kind": "document", "synonyms": ["cafr", "annual comprehensive financial report"] },
    "budget":           { "weight": 1.0, "kind": "document", "synonyms": ["adopted budget", "budget book"] },
    "finance director": { "weight": 0.9, "kind": "contact",  "synonyms": ["chief financial officer", "cfo", "treasurer"] }
  }
}
```

The defaults cover ACFR, budget, single audit and finance director, with their usual synonyms.
Scores are stored per crawl, so two crawls of the same site with different keywords never
overwrite each other.

### The LLM tier

Links that the rules score between 0.2 and 0.7 go to the LLM, 50 at a time, as short records:
link text, URL, heading and about 200 characters of nearby text. The LLM never sees a whole page
or a whole site. The answer must match a strict JSON schema and is validated in code. Answers
are cached by input, so a rerun costs nothing. If the call fails, the rules score stays. With no
`OPENAI_API_KEY`, the tier is off.

After the LLM answers, the same multipliers as the rules still apply (older fiscal years, drafts,
and pages on the entity's own site, which are nearly always the list rather than the document),
so the LLM confirms what a link is without flattening the ranking.

**Cost.** `gpt-4o-mini` by default. A crawl of the three reachable test sites (about 900 pages)
cost a few cents. `LLM_MAX_USD_PER_CRAWL` (default $0.50) is a hard cap: past it, the crawl
continues on rules alone and emits an `llm.capped` event.

### Contacts

1. **Find:** rules pick up every `mailto:` and `tel:` link, every email and phone in the text,
   and every place where a title from the keywords appears ("Chief Financial Officer",
   "Treasurer").
2. **Read:** the small block of text around it is parsed for patterns such as "Name, Title",
   a name on the line above the title, or "Title Name". With an LLM key, the LLM reads the block.
3. **Verify:** every value must appear in the block. A value that is not on the page is dropped,
   so the model cannot invent a contact.
4. **Score:** title weight, plus reachability (email, phone, email on the entity's domain) and
   whether the page is a finance page.

Some sites draw their cards with scripts from JSON embedded in the page. The extractor reads
that JSON too, which is how ASU's CFO is found without a browser.

### Crawling

- **Queue:** the frontier is a Postgres table. Workers claim the best URL whose host is free
  with `FOR UPDATE SKIP LOCKED` and lease the host, so there is never more than one request at a
  time per host, at least a second apart, longer for slow hosts. 10% of claims explore at random.
- **robots.txt:** per RFC 9309, cached for 24 hours. A 4xx means no rules; a 5xx or no answer
  means disallow everything. Crawl-delay, meta robots and `X-Robots-Tag` nofollow are honored.
- **Scope:** the seed's registrable domain and its subdomains. Links to other domains are
  stored and ranked, never crawled. If the start page redirects to another domain, that domain
  joins the crawl. A vendor host that carries the entity's name (boerneisd.smartsiteshost.com)
  joins too.
- **Traps:** far-future calendar dates, repeating path segments, too many parameters, very long
  URLs. Duplicate content is detected by hash. Depth and page budget cap every crawl.
- **Failures:** 4xx is final. Timeouts, network errors, 5xx and 429 are retried up to three
  times with backoff, honoring `Retry-After`. Five errors in a row pause a host. A site that
  refuses automated requests is reported as `blocked` and never bypassed.
- **Honest identity:** `User-Agent: HighValueLinkScraper/0.1 (+https://github.com/igalk1515/high-value-link-scraper)`.

---

## API

Interactive docs: http://localhost:3000/docs (OpenAPI JSON at `/docs/json`).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/crawls` | Start a crawl: `url`, optional `keywords`, `max_depth` (0 analyzes one page), `page_budget`. Answers 202. Send `Idempotency-Key` to make retries safe. |
| `GET` | `/v1/crawls` | Recent crawls |
| `GET` | `/v1/crawls/{id}` | Status, counters, pages being fetched now |
| `GET` | `/v1/crawls/{id}/pages` | Every URL the crawl considered, by status, with the reason for each skip or failure |
| `GET` | `/v1/crawls/{id}/events` | Live Server-Sent Events stream; resumes from `Last-Event-ID` |
| `GET` | `/v1/links` | Ranked links. `crawl_id`, or `host` for that site's latest crawl. Filters: `type`, `doc_type`, `fiscal_year`, `min_score`, `keyword`, `q` (full-text). Keyset pagination with `cursor`. |
| `GET` | `/v1/links/{id}` | One link with every place it was found |
| `GET` | `/v1/contacts` | Contacts, with the page and the text each was checked against |
| `GET` | `/live/{id}` | Watch page for a crawl |
| `GET` | `/health` | Database check, and whether the LLM tier is on |

### Examples

API_EXAMPLES

Errors always look like this:

```json
{ "error": { "code": "invalid_parameter", "param": "keywords.budget.weight", "message": "body.keywords.budget.weight: Number must be less than or equal to 1" } }
```

### Live view

Every step of a crawl is an event: `page.fetching`, `page.fetched`, `page.failed`,
`page.skipped` (with the reason), `link.found`, `contact.found`, `scope.added`, `host.paused`,
`stats`, and `crawl.done`, `crawl.blocked` or `crawl.failed`. Events are stored in
`crawl_events` and pushed to open streams. They also go out on a Postgres `NOTIFY` channel, so
a crawl started from the command line shows up live in the API's watch page.

```bash
curl -N http://localhost:3000/v1/crawls/<id>/events
```

---

## Data model

[migrations/001_init.sql](migrations/001_init.sql) holds the whole schema. The main split:

| Table | Holds | Key |
|---|---|---|
| `links` | Facts about a URL, the same in every crawl: label, type, file type, fiscal year, draft | `url_hash` |
| `link_scores` | Each crawl's scores: target, path, document type, matched keywords, reason, decided by | `(crawl_id, link_id)` |
| `sightings` | Every place a link was found: page, anchor, heading, nearby text | `(link_id, page_id, crawl_id)` |
| `contacts` | Name, title, email, phone, score, source page and snippet | `(crawl_id, name)` |
| `frontier` | Every URL a crawl considered: the queue and the seen set | `(crawl_id, url_hash)` |
| `pages`, `hosts`, `crawls`, `crawl_events`, `llm_cache` | Fetch results, robots.txt and politeness state, crawl status, live events, cached LLM answers | |

Built for volume: natural unique keys make every write an idempotent upsert, a page's links go
in three batched statements, indexes match the API's filters, pagination never uses OFFSET, and
raw pages are gzip files on disk keyed by URL hash, outside the database.

---

## Tests

`npm test` runs 90+ tests:

- **Unit:** URL normalization and scope, trap guards, the RFC 9309 examples, the fetcher (redirects,
  loops, size cap, timeouts, retry rules), keyword matching, fiscal years, rules scoring and
  contact extraction on pages saved from the four test sites, and the LLM tier against a fake API.
- **Integration** (needs the db container): a full crawl of a fake city website with every hard
  case (robots.txt, traps, a flaky page, a 404, a redirect, an opaque document URL, a contact,
  a blocked site), checking that no host ever gets two requests at once; and the API end to end,
  including validation, idempotency, pagination, full-text search and the SSE stream.

`npm run eval` measures the latest crawl of each test site against the hand-made must-find list
in [eval/must-find.json](eval/must-find.json) and writes [eval/results.md](eval/results.md).

---

## Known limits

- **Bozeman** refuses every automated request (HTTP 403 from its bot protection, even for
  robots.txt). The crawl is reported as blocked. It is not bypassed.
- **Pages drawn entirely by scripts**, like the ClearGov budget viewer, are flagged
  `needs_browser`. The link to them is still found and ranked. A headless browser for those pages
  is the next step.
- **Scanned PDFs** are not read. Documents are ranked by their link, not their content.

## At scale

The version for millions of pages a day (host-partitioned queues, separate fetch, browser and
parse pools, an object store, a Bloom-filter seen set, recrawl scheduling, a search index over
document text) is written up in [docs/design.html](docs/design.html), Design B.

## Project layout

```
src/
  api/          Fastify server, routes, Zod schemas
  crawler/      url, robots, fetcher, extract, runner (the crawl loop), rawstore
  ranking/      keywords, rules, fileinfo, contacts, llm
  store/        SQL for crawls, frontier, links, contacts
  cli/          fetch-one, analyze, crawl, eval
  events.ts     event bus (crawl_events + NOTIFY)
  app.ts        wiring
public/         watch page and start page
migrations/     SQL schema
test/           unit and integration tests, saved pages in test/fixtures
eval/           must-find list and results
docs/           design and build log
```
