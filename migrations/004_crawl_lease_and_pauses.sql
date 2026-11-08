-- 1. One process runs a crawl at a time. The runner takes a lease and renews it while it works;
--    another process may take the crawl over only when the lease is stale (the runner died).
alter table crawls add column runner_id text;
alter table crawls add column heartbeat_at timestamptz;

-- 2. A host paused after repeated errors is paused for a while, not forever. A permanent flag
--    left from an earlier crawl stopped a later crawl of the same site from ever starting.
alter table hosts add column paused_until timestamptz;
alter table hosts drop column blocked;
update hosts set consecutive_errors = 0;
