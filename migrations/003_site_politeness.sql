-- Politeness per site, not per host. The subdomains of one entity (cfo.asu.edu,
-- asuonline.asu.edu, ...) usually share servers and rate limits: a crawl that sent one request
-- at a time to each of them still got HTTP 429. A site is a registrable domain.
create table sites (
  site             text primary key,
  next_allowed_at  timestamptz not null default now(),
  backoff_ms       int not null default 0      -- grows on 429 and 503, shrinks on success
);

alter table hosts add column site text;
update hosts set site = host where site is null;  -- rewritten with the registrable domain by the app
insert into sites (site) select distinct site from hosts on conflict do nothing;
