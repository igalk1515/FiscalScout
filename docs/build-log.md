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
