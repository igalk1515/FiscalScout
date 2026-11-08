-- Schema for the high-value link scraper.
-- Facts about a URL (links, pages) are shared by every crawl. Anything that depends on a
-- crawl's keywords (link_scores, contacts) is stored per crawl.

create table crawls (
  id               uuid primary key,
  seed_url         text not null,
  keywords         jsonb not null,
  max_depth        int not null,
  page_budget      int not null,
  status           text not null default 'queued',   -- queued | running | done | blocked | failed
  status_detail    text,
  scope_domain     text not null,                    -- registrable domain of the seed, e.g. asu.edu
  extra_hosts      text[] not null default '{}',     -- hosts that joined the scope during the crawl
  idempotency_key  text unique,
  pages_fetched    int not null default 0,
  pages_failed     int not null default 0,
  llm_calls        int not null default 0,
  llm_cost_usd     numeric(10, 4) not null default 0,
  ranker_version   text not null,
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  finished_at      timestamptz
);

create table hosts (
  host               text primary key,
  robots_status      int,                 -- HTTP status of the robots.txt fetch, 0 = network error
  robots_txt         text,
  robots_fetched_at  timestamptz,
  crawl_delay_ms     int,                 -- from robots.txt, if any
  next_allowed_at    timestamptz not null default now(),
  consecutive_errors int not null default 0,
  blocked            boolean not null default false
);

create table frontier (                  -- every URL a crawl considered: the queue and the seen set
  crawl_id     uuid  not null references crawls on delete cascade,
  url_hash     bytea not null,             -- sha256(normalized url)
  url          text  not null,
  host         text  not null,
  depth        int   not null,
  path_score   real  not null,
  parent_url   text,
  status       text  not null default 'queued',  -- queued | fetching | done | failed | skipped
  reason       text,                             -- why it was skipped or failed
  http_status  int,
  attempts     int   not null default 0,
  not_before   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (crawl_id, url_hash)
);

create table pages (
  id             bigserial primary key,
  url_hash       bytea unique not null,
  url            text not null,
  final_url      text,                    -- after redirects
  host           text not null,
  http_status    int,
  content_type   text,
  content_hash   bytea,                   -- sha256(body): the same page under another URL
  bytes          int,
  title          text,
  raw_path       text,                    -- gzip file on disk
  needs_browser  boolean not null default false,
  fetched_at     timestamptz
);

create table links (                     -- facts about a URL, the same in every crawl
  id             bigserial primary key,
  url_hash       bytea unique not null,
  url            text not null,
  host           text not null,
  label          text,                    -- best anchor text seen
  type           text not null,           -- document | page
  file_type      text,                    -- pdf | xlsx | docx | csv | html | ...
  fiscal_year    int,
  is_draft       boolean not null default false,
  needs_browser  boolean not null default false,
  needs_ocr      boolean not null default false,
  search         tsvector generated always as
                   (to_tsvector('simple', coalesce(label, '') || ' ' || url)) stored,
  first_seen     timestamptz not null default now(),
  last_seen      timestamptz not null default now()
);

create table link_scores (               -- depends on the crawl's keywords
  crawl_id         uuid   not null references crawls on delete cascade,
  link_id          bigint not null references links,
  doc_type         text,                  -- keyword group matched: acfr | budget | finance director | ...
  target_score     real not null,
  path_score       real not null,
  matched_keywords text[] not null default '{}',
  reason           text,
  decided_by       text not null,         -- rules | llm
  ranker_version   text not null,
  primary key (crawl_id, link_id)
);

create table sightings (                 -- every place a link was found
  link_id          bigint not null references links,
  source_page_id   bigint not null references pages,
  crawl_id         uuid   not null references crawls on delete cascade,
  anchor_text      text,
  section_heading  text,
  context_snippet  text,
  in_boilerplate   boolean not null default false,
  depth            int,
  found_at         timestamptz not null default now(),
  primary key (link_id, source_page_id, crawl_id)
);

create table contacts (                  -- few rows, so each crawl keeps its own
  id               bigserial primary key,
  crawl_id         uuid not null references crawls on delete cascade,
  host             text not null,
  name             text not null,
  title            text,
  email            text,                  -- empty when the page shows none
  phone            text,
  score            real not null,
  matched_keywords text[] not null default '{}',
  source_page_id   bigint references pages,
  source_url       text,
  source_snippet   text,                  -- the text every field was checked against
  decided_by       text not null,         -- rules | llm
  unique (crawl_id, host, name)
);

create table crawl_events (              -- feeds the live view and its history
  id        bigserial primary key,
  crawl_id  uuid not null references crawls on delete cascade,
  type      text not null,                -- page.fetched | page.failed | page.skipped | link.found | contact.found | crawl.*
  data      jsonb not null,
  at        timestamptz not null default now()
);

create table llm_cache (                 -- reruns and tests never pay twice
  key             bytea primary key,      -- sha256(model + prompt version + input)
  model           text not null,
  prompt_version  text not null,
  response        jsonb not null,
  created_at      timestamptz not null default now()
);

create index frontier_claim_idx   on frontier (crawl_id, status, path_score desc);
create index link_scores_rank_idx on link_scores (crawl_id, target_score desc, link_id);
create index link_scores_type_idx on link_scores (crawl_id, doc_type);
create index links_host_idx       on links (host);
create index links_search_idx     on links using gin (search);
create index sightings_crawl_idx  on sightings (crawl_id, link_id);
create index contacts_rank_idx    on contacts (crawl_id, score desc);
create index crawl_events_idx     on crawl_events (crawl_id, id);
create index crawls_scope_idx     on crawls (scope_domain, created_at desc);
