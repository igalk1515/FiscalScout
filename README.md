<div align="center">

# FiscalScout

**Finds the budget, the annual financial report and the finance director on a public-sector website.**<br>
Ranks every link with learned weights, and serves the results through a REST API with a live view.

[Live demo](https://scraper.igal-web.com) · [Architecture](https://scraper.igal-web.com/architecture) · [How it works](docs/how-it-works.md) · [API](docs/api.md)

![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node-22-5FA04E?logo=nodedotjs&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)
![Tests](https://img.shields.io/badge/tests-173%20passing-2EA44F)
![License](https://img.shields.io/badge/license-MIT-blue)

</div>

<img src="docs/images/results.png" alt="Results page: ranked documents with the reason for each score, next to the finance contacts" width="100%">

## System design

### Design A · built

One Node process and one Postgres. The crawl queue, the results and the live events all live in
the same database, so the whole system starts with `docker compose up`.

```mermaid
flowchart LR
    api[Fastify API<br/>and live view] -->|start a crawl| frontier[(Frontier<br/>Postgres)]
    frontier -->|claim the best URL| workers[3 async workers<br/>one request per site]
    workers -->|new links + path score| frontier
    workers --> raw[(Raw pages<br/>gzip on disk)]
    workers --> rank{Rank<br/>learned weights}
    rank -.->|unsure| llm[LLM<br/>optional]
    rank --> store[(Postgres<br/>links · sightings · contacts)]
    llm -.-> store
    store --> api
```

### Design B · at millions of pages a day

Not built. The same stages, split into pools that scale on their own and talk through queues.

```mermaid
flowchart LR
    sched[Scheduler<br/>recrawl by change rate] --> queue[[Frontier queue<br/>partitioned by host]]
    queue --> fetch[Fetcher pool]
    fetch -.->|JS-heavy hosts| browser[Browser pool]
    fetch --> obj[(Object store<br/>raw pages)]
    obj --> parse[Parse + rank<br/>learned · vectors · LLM]
    parse -->|unseen links| queue
    parse --> pg[(Postgres<br/>source of truth)]
    pg -->|CDC| search[(Search index<br/>keywords + vectors)]
    obj --> docs[Documents<br/>OCR · chunks] --> search
    pg --> apiB[API]
    search --> apiB
```

| | Design A · built | Design B · at scale |
|---|---|---|
| **Queue** | Postgres table, `SKIP LOCKED` | Kafka or SQS, partitioned by host |
| **Seen set** | Unique key on the URL hash | Bloom filter in Redis, Postgres as the final word |
| **Raw pages** | Gzip files on local disk | Object store, keyed by content hash |
| **Ranking** | Learned weights, LLM when unsure | Adds embeddings and a learned path score |
| **Documents** | Ranked by their link | Full text, OCR, searchable chunks |
| **Freshness** | Crawl on request | Recrawl by change rate and the fiscal calendar |

[Design B in numbers →](docs/scaling.md) · [Both designs in full →](https://scraper.igal-web.com/architecture)

## The logic of links

Every link gets **two scores**. The **target score** says whether the link is the document
itself: the budget, the ACFR, the finance director's page. The **path score** says whether it
leads to one. The crawl follows the path score; the results sort by the target score.

```mermaid
flowchart LR
    link[Link<br/>text · URL · heading · nearby text] --> signals[22 signals]
    signals --> model{Learned weights<br/>logistic regression}
    model --> policy[Year and<br/>draft discounts]
    policy --> score([Target score<br/>+ reasons])
    policy -.->|0.2 to 0.7, LLM on| llm[LLM decides] -.-> score
```

A real result from Ann Arbor, with the reasons the API returns:

```text
Adopted Budget FY2026   (PDF, under "Annual Budgets")              target score 0.93
  names fiscal year 2026                       +2.4
  'budget' in the link text                    +1.8
  the link text is just the name and year      +1.1
  found on a page with path score 0.80         +0.6
  'budget' in the URL or file name             -0.6
```

- **The signals:** where the keyword sits, whether the link text is just a name and a year, and
  whether the link is a file, a list page, a paper about the document or another government's
  report.
- **The weights are learned:** fitted on 5,402 links from 22 public bodies that an LLM labeled,
  for $0.43. The hand-set rules are one switch away.
- **The LLM only when unsure:** it sees short link records, never whole pages, and the system
  runs without a key.
- **Contacts are results too:** name, title, email and phone, each checked against the page text.

[Ranking in depth →](docs/how-it-works.md#how-links-are-prioritized)

## Results

The four test sites from the brief, each crawled once with the default settings and ranked three
ways: hand-set rules, rules with an LLM, and the learned weights.

| Site | Must-find | Top-10 precision<br><sub>rules · LLM · learned</sub> |
|---|:---:|:---:|
| Ann Arbor | 3 / 3 | 10 · 10 · 10 |
| Boerne ISD | 3 / 3 | 10 · 10 · 10 |
| Arizona State | 3 / 3 | **7** · 10 · **10** |
| Bozeman | 2 / 3 | 9 · 9 · 9 |

The learned weights match the LLM without calling it. Across 22 sites, each scored by a model
that never saw it:

> **AUC 0.83** against 0.76 for the hand-set weights · **132 of 170** labeled targets in the top 10, against 118

Bozeman's miss is its finance director, listed last name first in a directory table.
[All the results →](docs/how-it-works.md#results-on-the-test-sites)

## Quick start

```bash
git clone https://github.com/igalk1515/FiscalScout.git && cd FiscalScout
docker compose up --build
```

Open **http://localhost:3000**, pick a test site and press **Crawl**. An OpenAI key is optional.
[Setup and commands →](docs/setup.md)

## API

```bash
curl -X POST localhost:3000/v1/crawls -H 'content-type: application/json' -d '{"url": "https://www.a2gov.org/"}'
curl 'localhost:3000/v1/links?host=a2gov.org&type=document&min_score=0.7'
curl 'localhost:3000/v1/contacts?host=a2gov.org'
```

Interactive docs at `/docs`. [Every endpoint, with real responses →](docs/api.md)

<details>
<summary><b>The live view of a crawl</b></summary>
<br>
<img src="docs/images/live.png" alt="Live view: every page fetched or skipped, with the reason, and the best documents found so far" width="100%">
</details>

## Read more

| Read | What is inside |
|---|---|
| [How it works](docs/how-it-works.md) | Results, ranking, learned weights, contacts, crawling, data model, tests, limits |
| [API](docs/api.md) | Every endpoint, with examples and real responses |
| [Setup](docs/setup.md) | Docker, local development, commands, settings |
| [At scale](docs/scaling.md) | Running it at millions of pages a day |
| [Architecture](https://scraper.igal-web.com/architecture) | The design and its decisions ([source](docs/design.html)) |
| [Build log](docs/build-log.md) | How each step was checked, and what the real sites taught |
