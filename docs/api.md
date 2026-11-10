[← Back to the README](../README.md)

# API

Interactive docs: http://localhost:3000/docs (OpenAPI JSON at `/docs/json`).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/crawls` | Start a crawl: `url`, optional `keywords`, `max_depth` (0 analyzes one page), `page_budget`, `respect_robots`, `use_llm`, `ranker` (`learned` or `rules`). Answers 202. Send `Idempotency-Key` to make retries safe. |
| `GET` | `/v1/crawls` | Recent crawls |
| `GET` | `/v1/crawls/{id}` | Status, counters, pages being fetched now |
| `GET` | `/v1/crawls/{id}/pages` | Every URL the crawl considered, by status, with the reason for each skip or failure |
| `GET` | `/v1/crawls/{id}/events` | Live Server-Sent Events stream; resumes from `Last-Event-ID` |
| `GET` | `/v1/links` | Ranked links. `crawl_id`, or `host` for that site's latest crawl. Filters: `type`, `doc_type`, `fiscal_year`, `min_score`, `keyword`, `q` (full-text). Keyset pagination with `cursor`. |
| `GET` | `/v1/links/{id}` | One link with every place it was found |
| `GET` | `/v1/contacts` | Contacts, with the page and the text each was checked against. Filters: `q` (words in the name, title or email), `keyword` (a keyword group such as `finance director`, or a term such as `purchasing`), `title`, `min_score` |
| `GET` | `/v1/keywords` | The default keyword groups, to start from |
| `POST` | `/v1/crawls/{id}/cancel` | Stop a queued or running crawl. Answers 202. Nothing new is fetched, pages in flight finish, and what was found stays readable. 409 if it already ended |
| `POST` | `/v1/crawls/{id}/rescore` | Re-rank a finished crawl from its saved pages, with new `keywords` or another `ranker`; `llm: true` runs the LLM tier too. 409 while the crawl is running |
| `GET` | `/results/{id}` | Results page: search, filters, keyword editor, re-rank |
| `GET` | `/live/{id}` | Watch page for a crawl |
| `GET` | `/health` | Database check, and whether the LLM tier is on |

## Examples

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

## Live view

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
