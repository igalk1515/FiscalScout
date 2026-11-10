[← Back to the README](../README.md)

# Setup

You need Docker. Node 20.12 or newer (22 recommended) is only needed to run outside Docker.

## Everything in Docker

```bash
git clone https://github.com/igalk1515/FiscalScout.git
cd FiscalScout
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

## Local development

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
| `npm run rescore -- <crawl-id> [--llm] [--ranker learned\|rules]` | Re-rank a finished crawl from the saved pages, without fetching (after a rule change) |
| `npm run eval -- --run [--out file]` | Crawl the four test sites, then measure them |
| `npm run learn -- dataset \| label \| train` | Build, label and fit the learned ranker (see [How it works](how-it-works.md#learned-weights-the-default-ranker)) |

Settings (all optional) are in [.env.example](../.env.example): `OPENAI_API_KEY`, `OPENAI_MODEL`,
`LLM_MAX_USD_PER_CRAWL`, `CRAWL_WORKERS`, `MIN_HOST_DELAY_MS`, `DATABASE_URL`, `RAW_DIR`, and for
the render tier `RENDER_JS`, `RENDER_MAX_PER_CRAWL`, `RENDER_TIMEOUT_MS`, `BROWSER_CHANNEL`,
`BROWSER_EXECUTABLE`.
