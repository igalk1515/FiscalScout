# High-Value Link Scraper

Finds the links on a public entity's website that lead to **budgets, annual financial reports
(ACFR) and finance contacts**, ranks them, and serves them through an API, with a live view of
every crawl.

- **Ranks every link** with weights learned from 5,402 labeled links on 22 public bodies
  (logistic regression over the rule signals), and keywords you set per crawl. The hand-set
  rules stay one switch away. An LLM decides only the links the ranker is unsure about, and the
  system runs fine without one.
- **Pulls out contacts and files as results:** a finance contact comes out as name, title, email
  and phone, each checked against the page text. A file comes out with its document type and
  fiscal year.
- **Crawls politely and with focus:** robots.txt (RFC 9309), one request at a time per host,
  trap guards, and the most promising link first, so a page budget lands on the finance pages.
- **Keeps provenance:** every link records every page it was found on, with the anchor text,
  the heading above it and the nearby text, and the reason for its score.
- **REST API** with OpenAPI docs, keyset pagination and one error shape, plus a
  Server-Sent Events stream and a watch page that shows each crawl live.

- **Running it at millions of pages a day:** [docs/scaling.md](docs/scaling.md), with numbers
  measured on the test crawls and what would break first.
- **How each build step was checked, and what the real sites taught:** [docs/build-log.md](docs/build-log.md).
- **The plan written before the build:** [docs/design.html](docs/design.html) (open it in a browser, or at `/architecture`
  when the server runs).

---

## Results on the test sites

**How it was measured:**
- **One final run on the final code, with the default settings.** Each site was crawled once
  from its home page: depth 3, a page budget of 300, the LLM on (`gpt-4o-mini`) and browser
  rendering off.
- **The same crawls, ranked twice:** once with the LLM and once with rules alone.
- **A hand-made must-find list.** [eval/must-find.json](eval/must-find.json) was built before the
  crawler ran. A target counts as found when it is in the top 10 of its type.
- **Precision@10:** how many of the ten best documents name a finance document (in the link
  text, the URL or the heading above the link) and belong to the entity.

Run it yourself with `npm run eval -- --run`.

| Site | Crawl | Must-find, rules only | Must-find, with LLM | Must-find, learned | Precision@10, rules only | Precision@10, with LLM | Precision@10, learned |
|---|---|---|---|---|---|---|---|
| Ann Arbor (a2gov.org) | 294 pages | 3/3 | 3/3 | 3/3 | 10/10 | 10/10 | 10/10 |
| Boerne ISD (boerneisd.net) | 288 pages | 3/3 | 3/3 | 3/3 | 10/10 | 10/10 | 10/10 |
| Arizona State University (asu.edu) | 292 pages | 3/3 | 3/3 | 3/3 | 7/10 | 10/10 | 10/10 |
| Bozeman (bozeman.net) | blocked | reported as blocked | reported as blocked | - | - | - | - |

**Learned** is the learned ranker with the LLM off, fitted only on the 18 other sites, so it
never saw these four (see [Learned weights](#learned-weights-the-default-ranker)).

These results predate the request identity changes described below. Bozeman rejected the old
custom crawler User-Agent but accepted both the Chrome header now used by default and Node's
standard HTTP client in direct page-fetch tests.

**Why ASU is 7/10 with rules alone.** ASU's finance site also links the State of Arizona's
budget summaries. A document on another government's site gets × 0.75, so with the LLM, ASU's
own reports and budgets fill the top 10, and the state's summaries come 11th and 12th. With
rules alone, the state's two summaries still lead at 0.71. ASU's own documents score lower:
their budgets are labeled only "FY 2027", and its ACFR scores 0.68, which is in the band the
rules hand to the LLM. The LLM confirms them. This is the cascade doing what it was designed to
do. The learned ranker gets to 10/10 without the LLM: ASU's own FY2027 budget and 2026 ACFR come
first, at 0.99, and the state's summaries drop out of the top 10.

What it found, first in each list:

| Site | ACFR | Budget | Finance contact |
|---|---|---|---|
| Ann Arbor | FY2025 ACFR (govstack CDN) | FY2026 adopted budget book; FY2027 on ClearGov | Marti Praschan, Chief Financial Officer, mpraschan@a2gov.org |
| Boerne ISD | FY2025 Annual Financial Report (file host) | 2026-27 adopted budget, PDF and Excel | Wesley Scott, Chief Financial Officer, wesley.scott@boerneisd.net |
| ASU | 2026 annual comprehensive financial report | FY2027 operating budget (Board of Regents SharePoint) | Morgan R. Olsen, Executive Vice President, Treasurer and CFO |
| Bozeman | the original run received 403 with the custom crawler User-Agent | | |

Two details worth knowing: ASU's finance site is reached without a browser through a footer link
called "Jobs" (the host name `cfo.asu.edu` carries the signal), and ASU's CFO is read from JSON
embedded in the page, because the card is drawn by a script.

Beyond the CFO, Boerne's crawl also returns the rest of the finance office, ranked below the
CFO. Each one has an email checked against the page:
- the purchasing director;
- the payroll manager;
- the assistant director of business services;
- the payroll specialists.

ASU's crawl returns 48 people from its finance offices.

**LLM cost:** the first LLM run over all three sites cost **$0.025** with `gpt-4o-mini`. The
final run cost $0.002, because answers seen before come from the cache.

**Full details:** [eval/results.md](eval/results.md) (with the LLM),
[eval/results-rules-only.md](eval/results-rules-only.md),
[eval/results-learned-test-sites.md](eval/results-learned-test-sites.md) and, for all 22 sites,
[eval/results-learned.md](eval/results-learned.md).

---

## What I prioritized, and what I left out

The brief says that prioritizing is part of the task. I built in this order, and each step was
checked on the real test sites before the next one started:

1. **Ranking the links on one page.** This is the objective: find budgets, ACFRs and finance
   contacts and score them, with keywords and weights set per crawl.
2. **Storage and the API** that the brief asks for: a schema built for volume, and a REST API
   with OpenAPI docs.
3. **A focused, polite crawler.** It only feeds pages to the ranker, so it spends its page
   budget on the most promising links first.
4. **An LLM only where the rules are unsure.** This keeps cost and latency low, and the system
   runs without a key.
5. **Evaluation:** a must-find list written by hand before the crawler ran, so "it works" is a
   number.
6. **A live view of each crawl.** It made debugging on real sites fast, and it shows how the
   crawler decides.
7. **Then the details the real sites asked for:**
   - adjustable keywords, re-ranking and search;
   - the rest of the finance office as contacts;
   - mirror hosts, broken links and stopping a crawl;
   - an opt-in browser for pages drawn by scripts.
8. **Learned weights.** The hand-set weights were guesses. Fitting them on labeled links from 22
   sites ranks better, and gets ASU right without the LLM.

**Left out on purpose.** All of these matter at scale, but they add little to four test sites.
Each one is described in [docs/scaling.md](docs/scaling.md):
- distributed queues, an object store and a recrawl scheduler;
- reading the text inside documents (OCR) and a search index for it;
- a learned path score for the crawl queue (only the target score is learned so far);
- authentication, rate limits and network restrictions on the API. Run it on a trusted
  network.

**HTTP access:** a configured User-Agent rejection gets one retry with Node's standard HTTP client.
A continued refusal is reported as blocked. Interactive challenges and sign-in pages are not
handled by this fallback.

---

## Setup

You need Docker. Node 20.12 or newer (22 recommended) is only needed to run outside Docker.

### Everything in Docker

```bash
docker compose up --build
```

Open http://localhost:3000, pick a test site, adjust the keywords and weights if you like, press
**Crawl**, and watch it live. Each crawl has a **results page** (`/results/{id}`): search the
documents and the contacts, filter by keyword, year and score, and change the keyword weights
and re-rank the crawl from its saved pages without crawling again. The API docs are at
http://localhost:3000/docs.

The crawl form has three switches, saved separately for each crawl:
- **Respect robots.txt** starts on. It controls robots.txt rules and crawl delays, including
  redirect targets and browser requests, plus page and link `nofollow` directives.
- **Use LLM** starts on when the server has an LLM API key. Switch it off to rank links and
  extract contacts without it. Without a key, the switch is disabled.
- **Learned ranking** starts on. Switch it off to rank with the hand-set rules.

API clients can pass `respect_robots` and `use_llm` as booleans to `POST /v1/crawls`.
Both default to `true`; without an API key, `use_llm` is saved as `false` for new crawls.
`ranker` is `learned` (the default) or `rules`.
The settings are returned with crawl details. Re-ranking on the results page has its own
LLM choice. Normal request pacing, scope and page limits still apply to every crawl.

An LLM key is optional. Without it, everything runs on rules alone:

```bash
OPENAI_API_KEY=sk-... docker compose up --build
```

The render tier for pages drawn by scripts needs a browser in the image (about 1.5 GB instead
of 350 MB), so it is opt-in:

```bash
WITH_BROWSER=1 RENDER_JS=true docker compose up --build
```

Outside Docker, it uses a browser already on the machine: `RENDER_JS=true BROWSER_CHANNEL=msedge`
(or `chrome`), or `BROWSER_EXECUTABLE=/path/to/chromium`.

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
| `npm run eval -- --run [--out file]` | Crawl the four test sites, then measure them |

Settings (all optional) are in [.env.example](.env.example): `OPENAI_API_KEY`, `OPENAI_MODEL`,
`LLM_MAX_USD_PER_CRAWL`, `CRAWL_WORKERS`, `MIN_HOST_DELAY_MS`, `DATABASE_URL`, `RAW_DIR`, and for
the render tier `RENDER_JS`, `RENDER_MAX_PER_CRAWL`, `RENDER_TIMEOUT_MS`, `BROWSER_CHANNEL`,
`BROWSER_EXECUTABLE`.

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
| A document on another government's site (`.gov`, `.mil`, state and local `.us`) | the state's budget summary, linked from a university | × 0.75 |
| Found on a page with a high path score | | +0.10 × parent's path score |
| Draft | `acfr-2023_draft.pdf` | −0.15 |
| A paper about the document | "FY27 Budget Responses", hearing notices, agendas | −0.20 |
| In a menu, header or footer | | −0.20 |
| Fiscal year | FY2025 when FY2027 is in progress | × 0.6–1.0 |
| Noise | social networks, login, calendars, news, images | score 0 |

The fiscal year comes from the strongest pattern found: "June 30, 2025" or "6-30-25", then
"FY2026" or "Fiscal Year 2025", then "2025-26" (named by the end year), then a bare year.

### Learned weights (the default ranker)

The weights in the table above are hand-set: my best guesses. The learned ranker reads the same
evidence and fits the weights on labeled links instead. A crawl picks one with `ranker`
(`learned`, the default, or `rules`), and `POST /v1/crawls/{id}/rescore` switches an existing
crawl from disk. The start page and the results page have the same switch.

**Model.** Logistic regression over 22 features of a link for one keyword group
([src/ranking/learned.ts](src/ranking/learned.ts)):
- where the keyword sits: link text, URL, heading, nearby text, host name;
- whether the link text is just the document's name and year, or carries other words;
- the kind of link: a file, a page on the entity's site, a page on another platform, another
  government's site, a paper about the document, a menu;
- the parent page's path score, whether a fiscal year is named, very long link text.

Keyword features are multiplied by the group's weight, so the keyword editor still works, and a
group at weight 0 is off. The output is the probability that the link itself is a target. The
year and draft discounts stay hand-set: they are ranking policy, not evidence of relevance, and
the same ones apply after the LLM. The path score that orders the crawl queue is still hand-set.

**Data.** 22 public bodies: the 4 test sites and 18 others
([eval/learn/sites.txt](eval/learn/sites.txt): 8 cities, 3 counties, 4 school districts,
3 universities), crawled with the LLM off. Every link with a keyword signal, once per site and
link text: 5,402 links ([eval/learn/links.jsonl](eval/learn/links.jsonl)).

**Labels.** `gpt-4.1-mini` labels each link as a target or not, against a strict definition: the
document itself, not the page that lists it, a presentation, answers to budget questions or
another government's report. The prompt is in [src/cli/learn.ts](src/cli/learn.ts).
- All 5,402 labels cost $0.43.
- A hand check of 60 random labels agreed on 58 ([eval/learn/handcheck.md](eval/learn/handcheck.md)).
- `gpt-4o-mini` was tried first. It labeled the same kind of link differently from one batch to
  the next.

**Training.** Newton's method on an L2-penalized log-likelihood
([src/ranking/logistic.ts](src/ranking/logistic.ts), no dependency). Each site counts the same
in total. Without that, Dane County's 476 department budget requests set the weights for
everyone.

**Evaluation: leave one site out.** Each site is scored by a model fitted on the other 21.

| | Hand-set rules | Learned |
|---|---|---|
| AUC over all labeled links | 0.762 | 0.833 |
| Labeled targets among each site's 10 best documents, summed | 118/170 | 132/170 |
| Sites where the top 10 is better / worse / the same | | 9 / 2 / 7 (4 sites have no documents to rank) |

On the test sites, a model fitted without them, with the LLM off, finds 9 of 9 must-find
targets and lifts ASU's precision@10 from 7 to 10 (table above).

**What it learned** (log-odds; full table in [eval/results-learned.md](eval/results-learned.md)):
- **Against a target:** a paper about the document (−3.9), a file matched by a contact title
  (−2.5), another government's site (−2.3), a page on the entity's own site named for a document
  (−2.3), other words in the link text besides the name and year (up to −1.6).
- **For a target:** link text that is only a year under a heading that names it (+4.4), a full
  name in the link text (+3.0), a fiscal year (+2.4), the keyword in the link text (+1.8), link
  text that is just the name and year (+1.1).
- **A surprise:** a keyword only in the URL counts slightly against (−0.6). Language switchers
  and menu pages carry "budget" in their URLs too.

**Limits.**
- The reference labels come from an LLM. They are noisy on borderline documents: a budget
  message, a budget in brief, one department's budget request. The two sites where the rules
  still win (Raleigh and Travis County) come down mostly to such cases.
- The model is linear, over features I chose. It cannot use evidence that no feature describes.

**Retrain:** `npm run crawl -- --file eval/learn/sites.txt --no-llm`, then
`npm run learn -- dataset`, `npm run learn -- label` and `npm run learn -- train`. Train writes
[src/ranking/learned-weights.ts](src/ranking/learned-weights.ts) and the evaluation.

### Path score

Keyword in the link text (+0.40 × weight), in the URL or **host name** (+0.30 × weight, which is
how `cfo.asu.edu` behind a footer link called "Jobs" gets picked up), finance hub words such as
finance, budget, transparency or treasurer (+0.25), navigation words such as departments or
documents (+0.12), and 0.15 × the parent page's path score. A link named for the office around
a contact title, such as "Purchasing" or "Payroll", gets +0.25 × weight: that is where those
people are listed.

### Keywords are set per crawl

```json
{
  "url": "https://www.a2gov.org/",
  "keywords": {
    "acfr":             { "weight": 1.0, "kind": "document", "synonyms": ["cafr", "annual comprehensive financial report"] },
    "budget":           { "weight": 1.0, "kind": "document", "synonyms": ["adopted budget", "budget book"] },
    "finance director": { "weight": 0.9, "kind": "contact",  "synonyms": ["chief financial officer", "cfo", "treasurer"],
                          "related": ["business services", "accounting", "payroll", "purchasing"] }
  }
}
```

The defaults cover ACFR, budget, single audit and finance director, with their usual synonyms.
A contact group can also list `related` titles: the rest of the office around the target, which
rank below it (see Contacts).
Scores are stored per crawl, so two crawls of the same site with different keywords never
overwrite each other.

**Change them after the crawl.** `POST /v1/crawls/{id}/rescore` with new keywords ranks every
page the crawl saved again, from disk, and keeps the new keywords on the crawl. Nothing is
fetched; without the LLM it costs nothing, and 300 pages take 10 to 40 seconds. Setting the
budget weight to 0, for example, drops the budgets out of the results and leaves the ACFRs. The
results page does the same with sliders.

### The LLM tier

Links that the rules score between 0.2 and 0.7 go to the LLM, 50 at a time, as short records:
link text, URL, heading and about 200 characters of nearby text. The LLM never sees a whole page
or a whole site. The answer must match a strict JSON schema and is validated in code. Answers
are cached by input, so a rerun costs nothing. If the call fails, the rules score stays. With no
`OPENAI_API_KEY`, the tier is off.

After the LLM answers, the same multipliers as the rules still apply, so the LLM confirms what a
link is without flattening the ranking:
- older fiscal years;
- drafts;
- documents on another government's site;
- pages on the entity's own site, which are nearly always the list rather than the document.

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
4. **Score:** how relevant the title is, times how complete the contact is.
   - Relevance: the group's main titles (finance director, CFO) 1.0, its other synonyms 0.85,
     a `related` title 0.6 for a leader (Purchasing Director, Payroll Manager) and 0.4 for staff
     (Payroll Specialist), times the group weight. A related word counts only inside a job title:
     "Payroll" alone is a department, not a person's title. Everyone else (HR, teachers) is not
     kept unless the crawl's keywords ask for them.
   - Completeness: email, an email on the entity's domain, phone, found on a finance page.

   On Boerne this gives the CFO first (0.86), then the purchasing director and the payroll
   manager (0.49), the assistant director of business services (0.46) and the payroll
   specialists (0.32).

Some sites draw their cards with scripts from JSON embedded in the page. The extractor reads
that JSON too, which is how ASU's CFO is found without a browser.

### Crawling

- **Queue:** the frontier is a Postgres table. Workers claim the best URL whose host is free
  with `FOR UPDATE SKIP LOCKED` and lease the host, so there is never more than one request at a
  time per host, at least a second apart, longer for slow hosts. 10% of claims explore at random.
- **Share of the budget:** no host may use more than 30% of the page budget, so one large
  subdomain (a university's online-degree site) cannot crowd out the rest. The entity's main
  site is exempt: the seed's host, where the seed redirects, and the host a mirrored seed points
  to.
- **robots.txt:** per RFC 9309, cached for 24 hours. A 4xx means no rules; a 5xx or no answer
  means disallow everything. Crawl-delay, meta robots and `X-Robots-Tag` nofollow are honored.
- **Scope:** the seed's registrable domain and its subdomains. Links to other domains are
  stored and ranked, never crawled. If the start page redirects to another domain, that domain
  joins the crawl. A vendor host that carries the entity's name (boerneisd.smartsiteshost.com)
  joins too.
- **Mirror hosts:** the same site can answer under several host names. Boerne's pages are
  served at `boerneisd.net`, `www.boerneisd.net` and `boerneisd.smartsiteshost.com`, and every
  copy names the `www` URL as canonical. When a page's canonical link is the same path on
  another in-scope host, the crawler marks its host as a mirror and reads every later URL on it
  under the original host, so the seen check drops the copies. Before this, more than a quarter
  of the Boerne budget went to copies (201 fetches for 121 distinct pages).
- **Traps:** far-future calendar dates, repeating path segments, too many parameters, very long
  URLs. Duplicate content is detected by hash. Depth and page budget cap every crawl.
- **HTTP 403 fallback:** retry once with Node's standard User-Agent when the configured request
  identity is refused. The retry waits at least one second (or the crawl's longer host delay),
  stays within the request timeout, and is shown as `page.retrying` in the live feed. Successful
  identities are remembered per origin for the runner's lifetime. The robots switch still
  applies, including rules for both the configured identity and the standard client. This also
  lets the crawler retrieve robots.txt when its configured identity is refused.
- **Failures:** a continued 403 is final. A 404 or 410 is reported as a broken link, with the page it was
  found on (`/v1/crawls/{id}/pages?status=broken`, and a list in the live view). Timeouts, network errors, 5xx and 429 are retried up to three
  times with backoff, honoring `Retry-After`. Five errors in a row pause a host. A site that
  continues to refuse requests is reported as `blocked`.
- **Render tier (`RENDER_JS=true`, off by default):** some pages arrive as an empty shell that
  scripts fill in. The plain fetch flags them `needs_browser`; with the render tier on, such a
  page is opened in a headless browser and read again. Only pages on the entity's own site that
  answered 200 are rendered, at most `RENDER_MAX_PER_CRAWL` (20) per crawl. A render is one polite
  visit: it holds the site's lease like a fetch, uses the same configured User-Agent, loads no
  images, fonts or styles, caps a page at 60 requests, and the browser may load a page or data
  URL only where robots.txt allows this bot. A page that refused us (401, 403, 429) is never
  opened in the browser, and a page that shows a bot check is reported and left alone; a
  bot-protection script on a page that loaded fully is not a check; a 429 in the browser slows
  the crawl down like a 429 to a fetch. Each page is rendered once, however many links lead to
  it, and sign-in pages are never rendered. Each page gets a fresh browser context, so no cookies
  carry over. Example: Boerne's jobs site on SchoolSpring is an empty
  shell to a plain fetch; rendered in 2.4 seconds, it lists the district's HR contacts.
- **Request identity:** defaults to `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36`.
  Set `HTTP_USER_AGENT` to override the full header. HTTP fetches, robots.txt requests and browser
  rendering use the same value; robots.txt matching uses its leading product token (`Mozilla`
  by default). The 403 fallback still uses Node's built-in User-Agent. `HTTP_USER_AGENT` replaces
  the former `BOT_NAME`/`BOT_URL` header settings.

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
| `GET` | `/v1/contacts` | Contacts, with the page and the text each was checked against. Filters: `q` (words in the name, title or email), `keyword` (a keyword group such as `finance director`, or a term such as `purchasing`), `title`, `min_score` |
| `GET` | `/v1/keywords` | The default keyword groups, to start from |
| `POST` | `/v1/crawls/{id}/cancel` | Stop a queued or running crawl. Answers 202. Nothing new is fetched, pages in flight finish, and what was found stays readable. 409 if it already ended |
| `POST` | `/v1/crawls/{id}/rescore` | Re-rank a finished crawl with new `keywords` from its saved pages; `llm: true` runs the LLM tier too. 409 while the crawl is running |
| `GET` | `/results/{id}` | Results page: search, filters, keyword editor, re-rank |
| `GET` | `/live/{id}` | Watch page for a crawl |
| `GET` | `/health` | Database check, and whether the LLM tier is on |

### Examples

Start a crawl, then follow it:

```bash
curl -X POST http://localhost:3000/v1/crawls   -H 'content-type: application/json' -H 'Idempotency-Key: a2gov-1'   -d '{"url": "https://www.a2gov.org/", "max_depth": 3, "page_budget": 300}'
# 202 {"id": "31c28e87-...", "status": "queued", "links": {"live": "/live/31c28e87-...", ...}}

curl http://localhost:3000/v1/crawls/31c28e87-...          # status and counters
open http://localhost:3000/live/31c28e87-...               # watch it
```

The best documents of a site's latest crawl (real response, trimmed):

```bash
curl 'http://localhost:3000/v1/links?host=a2gov.org&type=document&min_score=0.7&limit=1'
```

```json
{
  "crawl": { "id": "31c28e87-20b4-463e-951d-9a33c7063478", "seed_url": "https://www.a2gov.org/", "status": "done" },
  "data": [
    {
      "id": 12,
      "url": "https://www.a2gov.org/media/je4nrvnr/fy26-budget-book.pdf",
      "label": "Adopted Budget FY2026",
      "type": "document",
      "file_type": "pdf",
      "doc_type": "budget",
      "fiscal_year": 2026,
      "is_draft": false,
      "target_score": 1,
      "matched_keywords": ["budget"],
      "decided_by": "rules",
      "reason": "'budget' in the link text (+0.35); 'budget' in the URL or file name (+0.25); heading 'Annual Budgets' names it (+0.15); PDF document (+0.15); ...",
      "sources": [
        {
          "page": "https://www.a2gov.org/finance-and-administrative-services/financial-reporting/",
          "anchor_text": "Adopted Budget FY2026",
          "section_heading": "Annual Budgets",
          "context": "The annual budget is the City's plan for providing services to the community during the fiscal year..."
        }
      ]
    }
  ],
  "next_cursor": "eyJzIjoxLCJmIjoyMDI2LCJpZCI6MTJ9"
}
```

Contacts, each with the text it was checked against:

```bash
curl 'http://localhost:3000/v1/contacts?host=boerneisd.net&limit=1'
```

```json
{
  "data": [
    {
      "name": "Wesley Scott",
      "title": "Chief Financial Officer",
      "email": "wesley.scott@boerneisd.net",
      "score": 0.855,
      "source_url": "https://www.boerneisd.net/244573_3",
      "source_snippet": "Wesley Scott, CPA, RTSBA
Chief Financial Officer
Email Mr. Scott
Email: wesley.scott@boerneisd.net",
      "decided_by": "llm"
    }
  ]
}
```

Other useful queries:

```bash
curl 'http://localhost:3000/v1/links?host=asu.edu&doc_type=acfr&limit=3'       # ASU's ACFRs, newest first
curl 'http://localhost:3000/v1/links?host=boerneisd.net&fiscal_year=2027'       # everything for FY2027
curl 'http://localhost:3000/v1/links?host=a2gov.org&q=single+audit'             # full-text search
curl 'http://localhost:3000/v1/crawls/<id>/pages?status=skipped'                # what was skipped, and why
curl 'http://localhost:3000/v1/crawls/<id>/pages?status=broken'                 # broken links, with the page each was on
curl 'http://localhost:3000/v1/contacts?host=boerneisd.net&q=payroll'           # people whose name, title or email says payroll
curl 'http://localhost:3000/v1/contacts?host=boerneisd.net&keyword=purchasing'  # contacts matched through "purchasing"
curl -X POST http://localhost:3000/v1/crawls/<id>/rescore -H 'content-type: application/json' \
  -d '{"keywords": {"acfr": {"weight": 1, "kind": "document", "synonyms": ["annual financial report"]}}}'  # rank for the ACFR alone
```

Errors always look like this:

```json
{ "error": { "code": "invalid_parameter", "param": "keywords.budget.weight", "message": "body.keywords.budget.weight: Number must be less than or equal to 1" } }
```

### Live view

Every step of a crawl is an event:
- pages: `page.fetching`, `page.retrying`, `page.fetched`, `page.failed`, `page.skipped` (with the reason),
  `page.rendered`, `page.render_failed`;
- results: `link.found`, `contact.found`;
- crawl decisions: `scope.added`, `scope.mirror`, `host.paused`, `llm.capped`, `stats`;
- the end: `crawl.done`, `crawl.blocked`, `crawl.failed` or `crawl.cancelled`.

Events are stored in `crawl_events` and pushed to open streams. They also go out on a Postgres
`NOTIFY` channel, so a crawl started from the command line shows up live in the API's watch
page. The watch page has a **Stop crawl** button.

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

`npm test` runs 138 tests:

- **Unit:** URL normalization and scope, trap guards, the RFC 9309 examples, the fetcher (redirects,
  loops, size cap, timeouts, retry rules), keyword matching, fiscal years, rules scoring and
  contact extraction on pages saved from the four test sites, and the LLM tier against a fake API.
- **Integration** (needs the db container): a full crawl of a fake city website with every hard
  case (robots.txt, traps, a flaky page, a 404, a redirect, an opaque document URL, a contact,
  a blocked site), checking that no host ever gets two requests at once; and the API end to end,
  including validation, idempotency, pagination, full-text search and the SSE stream; a site
  served under two host names (mirror detection); stopping a crawl, including one that runs in
  a second runner sharing only the database; and the render tier against a site drawn
  entirely by scripts, with a robots.txt rule for a data URL, a bot-check page and a refused page.
  The render tests use a browser already on the machine and are skipped without one.

`npm run eval` measures the latest crawl of each test site against the hand-made must-find list
in [eval/must-find.json](eval/must-find.json) and writes [eval/results.md](eval/results.md).

---

## Known limits

- **Access restrictions:** the 403 fallback helps with rejected User-Agent headers. A server
  that also refuses the standard HTTP client is still reported as blocked.
- **Pages drawn entirely by scripts** are read only with the render tier on, and only on the
  entity's own site. The ClearGov budget viewer sits on ClearGov's host, so it stays a ranked
  link flagged `needs_browser`. Links that scripts open on click (no `href`) are not followed.
- **Scanned PDFs** are not read. Documents are ranked by their link, not their content, so
  search covers link text and URLs, not the text inside a document.

## At scale

[docs/scaling.md](docs/scaling.md) covers running this at one to three million pages a day. It
starts from numbers measured on the test crawls:

| Measure | Value |
|---|---|
| Pages per second, one site | 0.2–0.7 |
| Frontier rows per page | 5–12 |
| Gzipped page | 30 KB |
| Pages that need a browser | 5.5% |
| LLM cost per 1,000 pages | under $0.03 |

It then lists what would break first:
1. the frontier table;
2. vendor hosts shared by thousands of entities;
3. the LLM call inside the worker;
4. raw pages on local disk;
5. per-page events;
6. the API and the crawler sharing a process.

It ends with recrawl scheduling by the fiscal calendar, sites that block bots, and when to split
storage.

## Project layout

```
src/
  api/          Fastify server, routes, Zod schemas
  crawler/      url, robots, fetcher, extract, runner (the crawl loop), render (browser tier),
                rescore (re-rank from saved pages), rawstore
  ranking/      keywords, rules, fileinfo, contacts, llm, tier (when the LLM decides)
  store/        SQL for crawls, frontier, links, contacts
  cli/          fetch-one, analyze, crawl, rescore, eval, test-sites
  events.ts     event bus (crawl_events + NOTIFY)
  app.ts        wiring
public/         start page, watch page, results page, keyword editor (keywords.js)
migrations/     SQL schema, one file per change
test/           unit and integration tests, saved pages in test/fixtures
eval/           must-find list and results
docs/           scaling, build log, the plan written before the build
```
