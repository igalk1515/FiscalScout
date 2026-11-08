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
