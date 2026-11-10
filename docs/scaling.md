# Running this at millions of pages a day

The take-home runs as one process against one Postgres. This note covers what changes when the
same crawler has to cover every public entity, at one to three million pages a day. Most of
that work is not built. The numbers come from the test crawls in this repo, so they are
measured, not guessed. The places where the current build would break first come from
actually building it.

## What the test crawls measured

These are the final crawls in [eval/results.md](../eval/results.md). Each one started from the
home page, with depth 3 and a page budget of 300.

| Measure | Ann Arbor | Boerne ISD | ASU |
|---|---|---|---|
| Pages fetched | 294 | 288 | 292 |
| Wall time | 6.7 min | 27.9 min | 9.2 min |
| Pages per second, one site | 0.73 | 0.17 | 0.53 |
| Hosts visited | 6 | 21 | 43 |
| Frontier rows (every URL considered) | 1,627 | 1,738 | 3,528 |
| Stored events | 918 | 334 | 1,299 |
| Ranked links kept (score > 0) | 318 | 23 | 31 |

Across all 1,841 pages fetched while building:

- **Raw pages:** a gzipped page averages about 30 KB (56 MB in total).
- **Pages needing a browser:** 5.5% were flagged `needs_browser`, meaning they arrived as an
  empty shell that scripts fill in.
- **Rendering cost:** one rendered page (Boerne's SchoolSpring jobs site) took 2.4 seconds and
  48 requests.
- **LLM cost:** the first LLM run over the three reachable sites (about 900 pages, nothing
  cached) cost $0.025 with `gpt-4o-mini`. The final run cost $0.002, because answers seen before
  come from the cache.

What these numbers say:

- **Politeness sets the speed.** It allows one request per site at a time, at least a second
  apart, and longer for slow sites. At that pace a single site never goes faster than about
  0.2 to 0.7 pages a second. The only way to go faster overall is to crawl many sites at once.
- **The frontier is the table that grows.** It gets 5 to 12 rows for every page fetched, because
  every URL considered is kept with the reason it was skipped. The other tables grow far more
  slowly: links are stored only when they score above zero.
- **The LLM is cheap with the cascade.** Rules settle most links, and only the unsure ones go to
  the model. That works out to under $0.03 per 1,000 pages.

## The target, in numbers

| Quantity | Estimate | Basis |
|---|---|---|
| Entities | ~170,000 | Pursuit's public coverage figure (assumption to check) |
| Pages per entity per pass | ~200 | A focused crawl with a page budget: the test crawls found every target within 300 |
| Pages per pass | ~34M | 170,000 × 200 |
| Pages per day | ~1.1M (13/s); plan for 3M (35/s) | A monthly pass, and more often for pages that change |
| Sites in flight at once | ~25 at 1M/day, ~70 at 3M/day | 13–35 pages/s ÷ ~0.5 pages/s per site |
| Frontier rows per day | 5–12M at 1M pages | Measured ratio |
| Raw pages per day | ~30 GB at 1M pages (~0.9 TB a month) | Measured 30 KB per page |
| Pages to render per day | ~55,000, about 38 browser-hours | 5.5% × 2.5 s |
| LLM per day | up to about $30 at 1M pages | Measured $0.001–0.03 per 1,000 pages, before the savings below |

None of these numbers needs exotic infrastructure. The work is in keeping each part from
becoming the bottleneck.

## What is already built for it

- **The queue can be shared by many processes.** Workers claim URLs with `FOR UPDATE SKIP
  LOCKED`, so any number of worker processes can share one frontier, and no two take the same
  URL.
- **One runner per crawl.** Each crawl has a lease, renewed every 1.5 seconds. If a runner dies,
  another process takes the crawl over. A test runs a crawl in a second runner that shares
  only the database, and stops it through the first one's API.
- **Politeness is per site, across crawls.** A site lease in Postgres covers every crawl and
  every process, so two crawls never hit the same site at once.
- **No host takes more than 30% of a crawl's budget,** apart from the entity's main site.
- **Wasted fetches are cut, because at this scale waste is cost:**
  - Mirror hosts are detected. Before this, 201 of Boerne's fetches covered 121 distinct pages.
  - Duplicate content is detected by hash.
  - Trap guards stop endless calendars and repeating paths.
  - Sign-in pages are never opened in the browser.
  - Documents with a known file type are ranked by their link and never downloaded. An opaque
    link such as `/DocumentCenter/View/77` is fetched once to learn its type.
- **Writes are idempotent:** they are upserts on natural keys, and a page's links go in a few
  batched statements.
- **Pagination uses keys,** never OFFSET.
- **Raw pages are kept,** so a crawl can be re-ranked with new rules or keywords without
  fetching anything again (`POST /v1/crawls/{id}/rescore`).
- **The LLM is cached and capped:** answers are cached by input, and spending is capped per
  crawl.
- **The render tier is capped per crawl** and only opens pages that the plain fetch flagged.

## What breaks first, and the fix

In the order it would bite.

### 1. The frontier table grows without end

At 1M pages a day it gains 5 to 12 million rows a day, and it is also the claim query's index.
A frontier is only needed while its crawl runs, apart from the skip reasons shown in the API.

**Fix:**
- Partition `frontier` by crawl (or by day) and drop each partition once a crawl's results have
  been read.
- Keep a short summary of skip reasons per crawl.

When claim latency or lock waits climb (claim p99 above about 50 ms), move the queue to per-site
queues partitioned by registrable domain, on Kafka or SQS. That gives each site one owner, so
politeness stays a local decision.

### 2. Shared vendor hosts

Many entities publish on the same platforms:
- CivicPlus, Granicus and govstack CDNs
- ClearGov
- SharePoint
- SchoolSpring
- Finalsite and ParentSquare file hosts

The test crawls already hit three of these. At 170,000 entities, one CDN host may serve
thousands of them. Per-host politeness then makes that host the limit, and crawls that share it
queue behind each other.

**Fix:**
- Give the scheduler per-host rate limits that cover every crawl (the site lease already does
  this).
- Interleave entities, so no host's queue piles up.
- Avoid fetching from these hosts where possible: documents with a known file type are already
  ranked by their link without being downloaded.
- For the large platforms, ask for an allowed rate or use their feeds.

### 3. The LLM call blocks the worker

Today a worker waits for the LLM batch before it takes the next page. That is fine for one
crawl, but at 35 pages a second it ties throughput to the model's latency.

**Fix:**
- Score with rules inline, then queue only the unsure links for LLM workers that update the
  scores later. A link's score already records which tier decided it.
- Add a daily budget across all crawls, next to the per-crawl cap.
- Train a small classifier on the stored LLM decisions. Each decision is stored with its input
  and reason, so the training set already exists. After that, the LLM only sees what the
  classifier is unsure about.

### 4. Raw pages on local disk

Raw pages on local disk tie re-ranking to the machine that fetched them.

**Fix:**
- Move raw pages to an object store, keyed by content hash. Mirrors and unchanged pages are then
  stored once.
- At about 0.9 TB a month, keep the newest copy of each URL and expire older ones.

### 5. Events stored for every page

A crawl stores 1 to 4.5 events per page and sends each one through Postgres `NOTIFY`. That is good
for a person watching a crawl, but wasteful for 170,000 scheduled crawls nobody watches.

**Fix:**
- Store per-page events only while someone is watching, or only for crawls started by a person.
- Partition events by day and drop them after a week.
- Send metrics (pages per second per host, errors, LLM spend, render share) to a metrics system
  instead.

### 6. The API and the crawler share one process

Today the API and the crawler run in the same process.

**Fix:**
- Split into a stateless API, crawler workers that scale with queue depth, and a separate
  browser pool. The browser pool is memory-heavy and needs only about two busy browsers, or
  eight for peaks.

The lease and `SKIP LOCKED` already make that split possible without changing the crawl code.

## Freshness: what to recrawl, and when

Crawling every page of every entity every month wastes most fetches, because most pages have not
changed.

- **Send conditional requests** (`If-None-Match`, `If-Modified-Since`). An unchanged page costs a
  304 and no parsing.
- **Recrawl by change rate:** finance hub pages often, deep pages rarely.
- **Follow the fiscal calendar.** Most US cities and school districts close their fiscal year on
  June 30. Budgets are adopted in May and June, and ACFRs come out in December and January.
  Crawling finance pages harder in those windows finds new documents sooner, at no extra cost
  the rest of the year.

## Sites that block automated requests

Bozeman refused the crawler's original custom User-Agent with a 403, robots.txt included. At this
scale some share of sites will refuse requests the same way. The crawler handles this through its
request identity, with no per-site workarounds:

- **Default identity:** a desktop Chrome User-Agent (`HTTP_USER_AGENT`), which Bozeman accepts.
  robots.txt rules are matched against its leading product token.
- **403 fallback:** one retry with Node's standard User-Agent, at least a second later. The
  identity that worked is remembered per origin.
- **robots.txt:** respected by default, and switchable per crawl (`respect_robots`).

A site that also refuses the standard client is reported as blocked. At millions of pages a day,
these are the next steps:

- the header is one setting, so moving to an identified bot with a contact page that site owners
  can allow, if Pursuit prefers that, needs no code change;
- asking the large platforms for access;
- other sources for the same documents. For example, entities that issue bonds post their ACFRs
  to MSRB's EMMA as continuing disclosures.

## When to split storage

1. **Start with one Postgres** for records, full-text search and the queue, with raw bytes in an
   object store. This is the current design, minus local disk.
2. **Partition** `links`, `sightings` and `link_scores` by crawl or by month once they pass about
   100M rows.
3. **Add a search index** only when search inside document text arrives. Millions of documents at
   hundreds of chunks each need their own index for hybrid keyword and vector search. Feed it
   from Postgres through an outbox, so it can always be rebuilt.

## Rough cost at 1M pages a day

These are order-of-magnitude figures, to show that nothing here is expensive.

| Part | Size |
|---|---|
| Crawler workers | 2–4 small instances. The work is waiting on politeness delays and network, not CPU |
| Browser pool | 2–8 headless browsers |
| Postgres | One primary of about 8 vCPU and 32 GB, with partitions. Peak writes of about 1,000 rows a second |
| Object store | Grows by about 0.9 TB a month, roughly $20 a month more each month |
| LLM | Up to about $30 a day today, falling once the classifier takes over the easy cases |
