import { randomUUID } from "node:crypto";
import { registrableDomain } from "../crawler/url.js";
import { type Db, type DbClient, tx } from "../db/client.js";
import type { KeywordConfig } from "../ranking/keywords.js";

/** Host rows (robots.txt, errors) and their site rows (politeness: one request at a time per site). */
async function ensureHosts(q: Db | DbClient, hosts: string[]) {
  if (!hosts.length) return;
  const sites = hosts.map((h) => registrableDomain(h));
  await q.query("insert into sites (site) select unnest($1::text[]) on conflict do nothing", [[...new Set(sites)]]);
  await q.query(
    `insert into hosts (host, site) select * from unnest($1::text[], $2::text[])
     on conflict (host) do update set site = excluded.site where hosts.site is distinct from excluded.site`,
    [hosts, sites],
  );
}

export type CrawlStatus = "queued" | "running" | "done" | "blocked" | "failed" | "cancelled";

export interface CrawlRow {
  id: string;
  seed_url: string;
  keywords: KeywordConfig;
  max_depth: number;
  page_budget: number;
  respect_robots: boolean;
  use_llm: boolean;
  status: CrawlStatus;
  status_detail: string | null;
  scope_domain: string;
  extra_hosts: string[];
  idempotency_key: string | null;
  pages_fetched: number;
  pages_failed: number;
  llm_calls: number;
  llm_cost_usd: number;
  ranker_version: string;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  runner_id: string | null;
  heartbeat_at: Date | null;
}

export interface NewCrawl {
  seedUrl: string;
  keywords: KeywordConfig;
  maxDepth: number;
  pageBudget: number;
  respectRobots?: boolean;
  useLlm?: boolean;
  scopeDomain: string;
  rankerVersion: string;
  idempotencyKey?: string | null;
}

/** Creates a crawl and queues its seed. With an idempotency key, a repeat returns the first crawl. */
export async function createCrawl(
  db: Db,
  c: NewCrawl,
  seed: { hash: Buffer; host: string },
): Promise<{ crawl: CrawlRow; created: boolean }> {
  if (c.idempotencyKey) {
    const existing = await db.query<CrawlRow>("select * from crawls where idempotency_key = $1", [c.idempotencyKey]);
    if (existing.rows[0]) return { crawl: existing.rows[0], created: false };
  }
  return tx(db, async (client) => {
    const id = randomUUID();
    const inserted = await client.query<CrawlRow>(
      `insert into crawls (id, seed_url, keywords, max_depth, page_budget, scope_domain, ranker_version, idempotency_key, respect_robots, use_llm)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (idempotency_key) do nothing
       returning *`,
      [id, c.seedUrl, JSON.stringify(c.keywords), c.maxDepth, c.pageBudget, c.scopeDomain, c.rankerVersion, c.idempotencyKey ?? null, c.respectRobots ?? true, c.useLlm ?? true],
    );
    if (!inserted.rows[0]) {
      const again = await client.query<CrawlRow>("select * from crawls where idempotency_key = $1", [c.idempotencyKey]);
      return { crawl: again.rows[0]!, created: false };
    }
    await ensureHosts(client, [seed.host]);
    await client.query(
      `insert into frontier (crawl_id, url_hash, url, host, depth, path_score) values ($1, $2, $3, $4, 0, 1)`,
      [id, seed.hash, c.seedUrl, seed.host],
    );
    return { crawl: inserted.rows[0], created: true };
  });
}

export async function getCrawl(db: Db, id: string): Promise<CrawlRow | null> {
  const r = await db.query<CrawlRow>("select * from crawls where id = $1", [id]);
  return r.rows[0] ?? null;
}

export async function listCrawls(db: Db, limit: number): Promise<CrawlRow[]> {
  const r = await db.query<CrawlRow>("select * from crawls order by created_at desc limit $1", [limit]);
  return r.rows;
}

/** Latest crawl whose seed belongs to the host's registrable domain. */
export async function latestCrawlForDomain(db: Db, domain: string): Promise<CrawlRow | null> {
  const r = await db.query<CrawlRow>(
    "select * from crawls where scope_domain = $1 order by created_at desc limit 1",
    [domain],
  );
  return r.rows[0] ?? null;
}

/** After a re-rank with new keywords, the crawl's keywords are the ones its scores were made with. */
export async function setCrawlKeywords(db: Db, id: string, keywords: KeywordConfig) {
  await db.query("update crawls set keywords = $2 where id = $1", [id, JSON.stringify(keywords)]);
}

/** Sets the status, unless the crawl was cancelled: that is final. False when nothing changed. */
export async function setCrawlStatus(db: Db, id: string, status: CrawlStatus, detail: string | null = null): Promise<boolean> {
  const r = await db.query(
    `update crawls set status = $2, status_detail = $3,
       started_at = case when $2 = 'running' then coalesce(started_at, now()) else started_at end,
       finished_at = case when $2 in ('done', 'blocked', 'failed') then now() else finished_at end
     where id = $1 and status <> 'cancelled'`,
    [id, status, detail],
  );
  return (r.rowCount ?? 0) > 0;
}

export const CANCEL_REQUESTED = "cancelled by request";

/** Marks a queued or running crawl cancelled. Null when the crawl had already finished. */
export async function cancelCrawl(db: Db, id: string): Promise<CrawlRow | null> {
  const r = await db.query<CrawlRow>(
    `update crawls set status = 'cancelled', status_detail = $2, finished_at = now()
     where id = $1 and status in ('queued', 'running') returning *`,
    [id, CANCEL_REQUESTED],
  );
  return r.rows[0] ?? null;
}

/**
 * The runner and the API may both try to close a cancelled crawl; only the first one does, so
 * the crawl.cancelled event goes out once. True for the one that should announce it.
 */
export async function settleCancelled(db: Db, id: string, detail: string): Promise<boolean> {
  const r = await db.query(
    "update crawls set status_detail = $3 where id = $1 and status = 'cancelled' and status_detail = $2",
    [id, CANCEL_REQUESTED, detail],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function addExtraHost(db: Db, id: string, host: string) {
  await db.query(
    "update crawls set extra_hosts = array_append(extra_hosts, $2) where id = $1 and not ($2 = any(extra_hosts))",
    [id, host],
  );
}

export async function bumpCrawl(db: Db, id: string, d: { fetched?: number; failed?: number; llmCalls?: number; llmCost?: number }) {
  await db.query(
    `update crawls set pages_fetched = pages_fetched + $2, pages_failed = pages_failed + $3,
       llm_calls = llm_calls + $4, llm_cost_usd = llm_cost_usd + $5 where id = $1`,
    [id, d.fetched ?? 0, d.failed ?? 0, d.llmCalls ?? 0, d.llmCost ?? 0],
  );
}

// ---------------------------------------------------------------- frontier

export interface FrontierItem {
  url: string;
  url_hash: Buffer;
  host: string;
  depth: number;
  path_score: number;
  parent_url: string | null;
  attempts: number;
  /** Set when the claim was turned into a skip because the host used its share of the budget. */
  capped?: boolean;
}

/**
 * Claims the most promising queued URL whose site is free, and leases the site so no other
 * worker sends it a request until the lease is released. A site is a registrable domain:
 * cfo.asu.edu and asuonline.asu.edu count as one, because they share servers and rate limits.
 * SKIP LOCKED lets any number of workers share the queue without waiting on each other or
 * taking the same row.
 */
/**
 * Claims the best queued URL whose site is free. `maxPerHost` caps how many pages one host may
 * use, except the hosts in `uncapped`: the entity's main site, which holds most of its pages.
 */
export async function claimNext(
  db: Db,
  crawlId: string,
  explore: boolean,
  maxPerHost?: number,
  uncapped: ReadonlySet<string> = new Set(),
): Promise<FrontierItem | null> {
  return tx(db, async (client) => {
    const r = await client.query<FrontierItem & { site: string }>(
      `with next as (
         select f.crawl_id, f.url_hash, s.site
         from frontier f
         join hosts h on h.host = f.host
         join sites s on s.site = h.site
         where f.crawl_id = $1 and f.status = 'queued'
           and f.not_before <= now() and s.next_allowed_at <= now()
           and (h.paused_until is null or h.paused_until <= now())
         order by case when $2 then random() else 0 end, f.path_score desc, f.depth asc
         limit 1
         for update of f, s skip locked
       )
       update frontier f set status = 'fetching', attempts = f.attempts + 1, updated_at = now()
       from next where f.crawl_id = next.crawl_id and f.url_hash = next.url_hash
       returning f.url, f.url_hash, f.host, f.depth, f.path_score, f.parent_url, f.attempts, next.site`,
      [crawlId, explore],
    );
    const item = r.rows[0];
    if (!item) return null;
    // Lease the site: nobody else may send it a request until releaseHost sets the next time.
    await client.query("update sites set next_allowed_at = now() + interval '10 minutes' where site = $1", [item.site]);
    if (maxPerHost && !uncapped.has(item.host)) {
      // One host may not use up the whole page budget (a university's online-degree site).
      const used = await client.query<{ n: number }>(
        "select count(*)::int as n from frontier where crawl_id = $1 and host = $2 and status in ('done', 'failed', 'fetching')",
        [crawlId, item.host],
      );
      if (used.rows[0]!.n > maxPerHost) {
        await client.query(
          `update frontier set status = 'skipped', reason = 'host share of the page budget used', updated_at = now()
           where crawl_id = $1 and host = $2 and (status = 'queued' or url_hash = $3)`,
          [crawlId, item.host, item.url_hash],
        );
        await client.query("update sites set next_allowed_at = now() where site = $1", [item.site]);
        return { ...item, capped: true } as FrontierItem;
      }
    }
    return item;
  });
}

export type FetchOutcome = "ok" | "error" | "slow_down";

/**
 * Ends the site lease: the next request may go out after delayMs, or later while the site is
 * asking us to slow down (429 or 503 double a backoff, up to a minute; success halves it).
 * Five other errors in a row pause the host for 15 minutes. Returns true when it was just paused.
 */
export async function releaseHost(db: Db, host: string, delayMs: number, outcome: FetchOutcome, retryAfterMs = 0): Promise<boolean> {
  await db.query(
    `update sites s set
       backoff_ms = case when $3 = 'slow_down' then least(60000, greatest(2000, s.backoff_ms * 2)) else s.backoff_ms / 2 end,
       next_allowed_at = now() + make_interval(secs => greatest($2::float8,
         case when $3 = 'slow_down' then least(60000, greatest(2000, s.backoff_ms * 2)) else s.backoff_ms / 2 end, least($4::float8, 600000)) / 1000)
     from hosts h where h.host = $1 and s.site = h.site`,
    [host, delayMs, outcome, retryAfterMs],
  );
  const r = await db.query<{ paused: boolean }>(
    `update hosts set
       paused_until = case when $2 = 'error' and consecutive_errors + 1 >= 5 then now() + interval '15 minutes' else paused_until end,
       consecutive_errors = case
         when $2 = 'error' and consecutive_errors + 1 >= 5 then 0
         when $2 = 'error' then consecutive_errors + 1
         when $2 = 'ok' then 0
         else consecutive_errors end
     where host = $1
     returning paused_until is not null and paused_until > now() + interval '14 minutes' as paused`,
    [host, outcome],
  );
  return r.rows[0]?.paused ?? false;
}

/**
 * Takes the crawl for this process. Only one runner works on a crawl; another may take over when
 * the runner stops renewing its lease (it crashed or was stopped).
 */
export async function acquireCrawl(db: Db, crawlId: string, runnerId: string): Promise<boolean> {
  const r = await db.query(
    `update crawls set runner_id = $2, heartbeat_at = now()
     where id = $1 and (runner_id is null or runner_id = $2 or heartbeat_at < now() - interval '30 seconds')
     returning id`,
    [crawlId, runnerId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Renews the runner's lease. Returns the crawl's status, so a runner learns it was cancelled. */
export async function heartbeat(db: Db, crawlId: string, runnerId: string): Promise<CrawlStatus | null> {
  const r = await db.query<{ status: CrawlStatus }>(
    "update crawls set heartbeat_at = now() where id = $1 and runner_id = $2 returning status",
    [crawlId, runnerId],
  );
  return r.rows[0]?.status ?? null;
}

export async function finishItem(db: Db, crawlId: string, hash: Buffer, status: "done" | "failed" | "skipped", httpStatus: number | null, reason: string | null) {
  await db.query(
    "update frontier set status = $3, http_status = $4, reason = $5, updated_at = now() where crawl_id = $1 and url_hash = $2",
    [crawlId, hash, status, httpStatus, reason],
  );
}

export async function requeueItem(db: Db, crawlId: string, hash: Buffer, delayMs: number, reason: string) {
  await db.query(
    `update frontier set status = 'queued', reason = $4, updated_at = now(),
       not_before = now() + make_interval(secs => $3::float8 / 1000)
     where crawl_id = $1 and url_hash = $2`,
    [crawlId, hash, delayMs, reason],
  );
}

/** Queued and in-flight counts, and how many seconds until the next queued URL can be claimed. */
export async function pendingCounts(db: Db, crawlId: string): Promise<{ queued: number; fetching: number; waitSeconds: number | null }> {
  const r = await db.query<{ queued: number; fetching: number; wait_seconds: number | null }>(
    `select count(*) filter (where f.status = 'queued')::int as queued,
            count(*) filter (where f.status = 'fetching')::int as fetching,
            extract(epoch from min(greatest(f.not_before, s.next_allowed_at, coalesce(h.paused_until, now())) - now())
              filter (where f.status = 'queued'))::float8 as wait_seconds
     from frontier f
     left join hosts h on h.host = f.host
     left join sites s on s.site = h.site
     where f.crawl_id = $1 and f.status in ('queued', 'fetching')`,
    [crawlId],
  );
  const row = r.rows[0]!;
  return { queued: row.queued, fetching: row.fetching, waitSeconds: row.wait_seconds };
}

/** After a restart, URLs left in "fetching" go back to the queue and stale host leases end. */
export async function resetStale(db: Db, crawlId: string) {
  await db.query("update frontier set status = 'queued' where crawl_id = $1 and status = 'fetching'", [crawlId]);
  await db.query(
    `update sites set next_allowed_at = now()
     where next_allowed_at > now() + interval '2 minutes'
       and site in (select distinct h.site from frontier f join hosts h on h.host = f.host where f.crawl_id = $1)`,
    [crawlId],
  );
}

export async function skipQueued(db: Db, crawlId: string, reason: string, host?: string): Promise<number> {
  const r = await db.query(
    `update frontier set status = 'skipped', reason = $2, updated_at = now()
     where crawl_id = $1 and status = 'queued' and ($3::text is null or host = $3)`,
    [crawlId, reason, host ?? null],
  );
  return r.rowCount ?? 0;
}

export interface EnqueueRow {
  hash: Buffer;
  url: string;
  host: string;
  depth: number;
  pathScore: number;
  parent: string;
  status: "queued" | "skipped";
  reason: string | null;
}

/**
 * Adds URLs to the frontier. The primary key (crawl, url hash) is the seen check: a URL already
 * there is not added again, but a queued one keeps the best path score found so far.
 * Returns the rows that were new.
 */
export async function enqueue(db: Db, crawlId: string, rows: EnqueueRow[]): Promise<{ url: string; status: string; reason: string | null }[]> {
  if (!rows.length) return [];
  await ensureHosts(db, [...new Set(rows.filter((r) => r.status === "queued").map((r) => r.host))]);
  const payload = rows.map((r) => ({
    h: r.hash.toString("hex"),
    url: r.url,
    host: r.host,
    depth: r.depth,
    path_score: r.pathScore,
    parent: r.parent,
    status: r.status,
    reason: r.reason,
  }));
  const res = await db.query<{ url: string; status: string; reason: string | null; inserted: boolean }>(
    `insert into frontier (crawl_id, url_hash, url, host, depth, path_score, parent_url, status, reason)
     select $1, decode(r.h, 'hex'), r.url, r.host, r.depth, r.path_score, r.parent, r.status, r.reason
     from jsonb_to_recordset($2::jsonb) as r(h text, url text, host text, depth int, path_score real, parent text, status text, reason text)
     on conflict (crawl_id, url_hash) do update set path_score = greatest(frontier.path_score, excluded.path_score)
       where frontier.status = 'queued' and excluded.status = 'queued' and excluded.path_score > frontier.path_score
     returning url, status, reason, (xmax = 0) as inserted`,
    [crawlId, JSON.stringify(payload)],
  );
  return res.rows.filter((r) => r.inserted);
}

/**
 * Records that a URL is being read through its copy on a mirror host, so it is not fetched again.
 * Returns false when the URL was already read (or is being read): the copy is then a duplicate.
 */
export async function markReadAs(db: Db, crawlId: string, row: EnqueueRow): Promise<boolean> {
  if ((await enqueue(db, crawlId, [{ ...row, status: "skipped" }])).length) return true;
  const cur = await db.query<{ status: string }>("select status from frontier where crawl_id = $1 and url_hash = $2", [crawlId, row.hash]);
  const status = cur.rows[0]?.status;
  if (status === "done" || status === "fetching") return false;
  if (status === "queued") await finishItem(db, crawlId, row.hash, "skipped", null, row.reason);
  return true;
}

// ---------------------------------------------------------------- hosts and robots.txt

export async function getRobots(db: Db, host: string): Promise<{ status: number; text: string | null; fetchedAt: Date } | null> {
  const r = await db.query<{ robots_status: number | null; robots_txt: string | null; robots_fetched_at: Date | null }>(
    "select robots_status, robots_txt, robots_fetched_at from hosts where host = $1",
    [host],
  );
  const row = r.rows[0];
  if (!row || row.robots_status === null || !row.robots_fetched_at) return null;
  return { status: row.robots_status, text: row.robots_txt, fetchedAt: row.robots_fetched_at };
}

export async function saveRobots(db: Db, host: string, status: number, text: string | null, crawlDelayMs: number | undefined) {
  await ensureHosts(db, [host]);
  await db.query(
    "update hosts set robots_status = $2, robots_txt = $3, robots_fetched_at = now(), crawl_delay_ms = $4 where host = $1",
    [host, status, text, crawlDelayMs ?? null],
  );
}

export async function pausedHosts(db: Db, hosts: string[]): Promise<string[]> {
  const r = await db.query<{ host: string }>("select host from hosts where paused_until > now() and host = any($1::text[])", [hosts]);
  return r.rows.map((x) => x.host);
}

// ---------------------------------------------------------------- pages, links, contacts

export interface PageRecord {
  hash: Buffer;
  url: string;
  finalUrl: string;
  host: string;
  status: number;
  contentType: string | null;
  contentHash: Buffer | null;
  bytes: number;
  title: string | null;
  rawPath: string | null;
  needsBrowser: boolean;
  /** The page was opened in the headless browser and the stored HTML is the rendered one. */
  rendered?: boolean;
}

export async function upsertPage(db: Db, p: PageRecord): Promise<number> {
  const r = await db.query<{ id: number }>(
    `insert into pages (url_hash, url, final_url, host, http_status, content_type, content_hash, bytes, title, raw_path, needs_browser, rendered, fetched_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
     on conflict (url_hash) do update set final_url = $3, http_status = $5, content_type = $6, content_hash = $7,
       bytes = $8, title = $9, raw_path = $10, needs_browser = $11, rendered = $12, fetched_at = now()
     returning id`,
    [p.hash, p.url, p.finalUrl, p.host, p.status, p.contentType, p.contentHash, p.bytes, p.title, p.rawPath, p.needsBrowser, p.rendered ?? false],
  );
  if (p.needsBrowser) await db.query("update links set needs_browser = true where url_hash = $1", [p.hash]);
  return r.rows[0]!.id;
}

/**
 * Takes the site's lease for a request made outside the queue (opening a page in the browser),
 * waiting up to maxWaitMs for the site to be free. Release it with releaseHost.
 */
export async function acquireSite(db: Db, host: string, maxWaitMs = 60_000): Promise<boolean> {
  const until = Date.now() + maxWaitMs;
  while (Date.now() < until) {
    const r = await db.query(
      `update sites s set next_allowed_at = now() + interval '10 minutes'
       from hosts h where h.host = $1 and s.site = h.site and s.next_allowed_at <= now()`,
      [host],
    );
    if (r.rowCount) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

export interface LinkRecord {
  hash: Buffer;
  url: string;
  host: string;
  label: string;
  type: "document" | "page";
  fileType: string | null;
  fiscalYear: number | null;
  isDraft: boolean;
  docType: string | null;
  targetScore: number;
  pathScore: number;
  matchedKeywords: string[];
  reason: string;
  decidedBy: "rules" | "llm" | "learned";
  anchor: string;
  heading: string;
  context: string;
  boilerplate: boolean;
}

/**
 * Stores the links found on one page in three batched statements: the URL facts (links), this
 * crawl's scores (link_scores, keeping the best score seen), and where it was seen (sightings).
 * Returns the links whose score is new or improved in this crawl.
 */
export async function saveLinks(
  db: Db,
  crawlId: string,
  pageId: number,
  depth: number,
  rankerVersion: string,
  links: LinkRecord[],
): Promise<{ linkId: number; url: string; targetScore: number; docType: string | null; fiscalYear: number | null; type: string; isNew: boolean }[]> {
  if (!links.length) return [];
  return tx(db, async (client) => {
    const facts = await client.query<{ id: number; url_hash: Buffer }>(
      `insert into links (url_hash, url, host, label, type, file_type, fiscal_year, is_draft)
       select decode(r.h, 'hex'), r.url, r.host, r.label, r.type, r.file_type, r.fiscal_year, r.is_draft
       from jsonb_to_recordset($1::jsonb) as r(h text, url text, host text, label text, type text, file_type text, fiscal_year int, is_draft boolean)
       on conflict (url_hash) do update set
         last_seen = now(),
         label = coalesce(nullif(links.label, ''), excluded.label),
         type = case when excluded.type = 'document' then 'document' else links.type end,
         file_type = coalesce(excluded.file_type, links.file_type),
         fiscal_year = coalesce(links.fiscal_year, excluded.fiscal_year),
         is_draft = links.is_draft or excluded.is_draft
       returning id, url_hash`,
      [
        JSON.stringify(
          links.map((l) => ({
            h: l.hash.toString("hex"),
            url: l.url,
            host: l.host,
            label: l.label,
            type: l.type,
            file_type: l.fileType,
            fiscal_year: l.fiscalYear,
            is_draft: l.isDraft,
          })),
        ),
      ],
    );
    const idByHash = new Map(facts.rows.map((r) => [r.url_hash.toString("hex"), r.id]));
    const withIds = links.map((l) => ({ ...l, id: idByHash.get(l.hash.toString("hex"))! }));

    const scores = await client.query<{ link_id: number; target_score: number; doc_type: string | null; inserted: boolean; improved: boolean }>(
      `insert into link_scores (crawl_id, link_id, doc_type, target_score, path_score, matched_keywords, reason, decided_by, ranker_version)
       select $1, r.link_id, r.doc_type, r.target_score, r.path_score,
              coalesce(array(select jsonb_array_elements_text(r.mk)), '{}'), r.reason, r.decided_by, $2
       from jsonb_to_recordset($3::jsonb) as r(link_id bigint, doc_type text, target_score real, path_score real, mk jsonb, reason text, decided_by text)
       on conflict (crawl_id, link_id) do update set
         doc_type = case when excluded.target_score > link_scores.target_score then excluded.doc_type else link_scores.doc_type end,
         reason = case when excluded.target_score > link_scores.target_score then excluded.reason else link_scores.reason end,
         decided_by = case when excluded.target_score > link_scores.target_score then excluded.decided_by else link_scores.decided_by end,
         matched_keywords = array(select distinct unnest(link_scores.matched_keywords || excluded.matched_keywords)),
         target_score = greatest(link_scores.target_score, excluded.target_score),
         path_score = greatest(link_scores.path_score, excluded.path_score)
       returning link_id, target_score, doc_type, (xmax = 0) as inserted, true as improved`,
      [
        crawlId,
        rankerVersion,
        JSON.stringify(
          withIds.map((l) => ({
            link_id: l.id,
            doc_type: l.docType,
            target_score: l.targetScore,
            path_score: l.pathScore,
            mk: l.matchedKeywords,
            reason: l.reason,
            decided_by: l.decidedBy,
          })),
        ),
      ],
    );

    await client.query(
      `insert into sightings (link_id, source_page_id, crawl_id, anchor_text, section_heading, context_snippet, in_boilerplate, depth)
       select r.link_id, $1, $2, r.anchor, r.heading, r.context, r.boilerplate, $3
       from jsonb_to_recordset($4::jsonb) as r(link_id bigint, anchor text, heading text, context text, boilerplate boolean)
       on conflict do nothing`,
      [
        pageId,
        crawlId,
        depth,
        JSON.stringify(
          withIds.map((l) => ({ link_id: l.id, anchor: l.anchor, heading: l.heading, context: l.context, boilerplate: l.boilerplate })),
        ),
      ],
    );

    const byId = new Map(withIds.map((l) => [l.id, l]));
    return scores.rows.map((s) => {
      const l = byId.get(s.link_id)!;
      return { linkId: s.link_id, url: l.url, targetScore: s.target_score, docType: s.doc_type, fiscalYear: l.fiscalYear, type: l.type, isNew: s.inserted };
    });
  });
}

/** A queued URL whose extension said nothing turned out to be a document. */
export async function markDocument(db: Db, crawlId: string, hash: Buffer, fileType: string | null) {
  const r = await db.query<{ id: number }>(
    "update links set type = 'document', file_type = coalesce($2, file_type) where url_hash = $1 returning id",
    [hash, fileType],
  );
  const id = r.rows[0]?.id;
  if (!id) return;
  await db.query(
    `update link_scores set target_score = least(1, target_score + 0.15),
       reason = reason || '; the URL turned out to be a ' || upper(coalesce($3, 'document')) || ' (+0.15)'
     where crawl_id = $1 and link_id = $2`,
    [crawlId, id, fileType],
  );
}

export interface ContactRecord {
  host: string;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  score: number;
  matchedKeywords: string[];
  sourcePageId: number;
  sourceUrl: string;
  snippet: string;
  decidedBy: "rules" | "llm";
}

/**
 * Two spellings of one person's name: the same last name, and one first name is the short form
 * of the other ("Wes Scott" and "Wesley Scott"), with titles that agree.
 */
export function samePerson(a: { name: string; title: string | null }, b: { name: string; title: string | null }): boolean {
  const ta = a.name.toLowerCase().split(/\s+/);
  const tb = b.name.toLowerCase().split(/\s+/);
  if (ta[ta.length - 1] !== tb[tb.length - 1]) return false;
  const [fa, fb] = [ta[0]!, tb[0]!];
  if (fa === fb || fa.length < 3 || fb.length < 3 || !(fa.startsWith(fb) || fb.startsWith(fa))) return false;
  const [x, y] = [(a.title ?? "").toLowerCase(), (b.title ?? "").toLowerCase()];
  return !x || !y || x.includes(y) || y.includes(x);
}

/**
 * Stores contacts for a crawl, one row per person: the same name, the same email under another
 * name, or a short form of the name with the same title ("Wes Scott" and "Wesley Scott") is one
 * contact. Returns the names that are new.
 */
export async function saveContacts(db: Db, crawlId: string, contacts: ContactRecord[]): Promise<string[]> {
  const fresh: string[] = [];
  for (const c of contacts) {
    let prev: { id: number } | undefined;
    if (c.email) {
      const same = await db.query<{ id: number; name: string }>(
        "select id, name from contacts where crawl_id = $1 and email = $2 and name <> $3 limit 1",
        [crawlId, c.email, c.name],
      );
      prev = same.rows[0];
    }
    if (!prev) {
      const last = c.name.split(/\s+/).pop()!;
      const others = await db.query<{ id: number; name: string; title: string | null }>(
        `select id, name, title from contacts where crawl_id = $1 and name <> $2 and lower(name) like '% ' || lower($3)
           and not exists (select 1 from contacts x where x.crawl_id = $1 and x.name = $2)`,
        [crawlId, c.name, last],
      );
      prev = others.rows.find((o) => samePerson(o, c));
    }
    if (prev) {
      await db.query(
        `update contacts set
           name = case when length($2) > length(name) then $2 else name end,
           title = case when length(coalesce($3, '')) > length(coalesce(title, '')) then $3 else title end,
           email = coalesce(email, $6), phone = coalesce(phone, $4), score = greatest(score, $5)
         where id = $1`,
        [prev.id, c.name, c.title, c.phone, c.score, c.email],
      );
      continue;
    }
    const r = await db.query<{ inserted: boolean }>(
      `insert into contacts (crawl_id, host, name, title, email, phone, score, matched_keywords, source_page_id, source_url, source_snippet, decided_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict (crawl_id, name) do update set
         title = case when length(coalesce(excluded.title, '')) > length(coalesce(contacts.title, '')) then excluded.title else contacts.title end,
         email = coalesce(contacts.email, excluded.email),
         phone = coalesce(contacts.phone, excluded.phone),
         score = greatest(contacts.score, excluded.score)
       returning (xmax = 0) as inserted`,
      [crawlId, c.host, c.name, c.title, c.email, c.phone, c.score, c.matchedKeywords, c.sourcePageId, c.sourceUrl, c.snippet, c.decidedBy],
    );
    if (r.rows[0]?.inserted) fresh.push(c.name);
  }
  return fresh;
}

export async function crawlCounters(db: Db, crawlId: string) {
  const r = await db.query(
    `select
       (select count(*) from frontier where crawl_id = $1 and status = 'queued')::int as pages_queued,
       (select count(*) from frontier where crawl_id = $1 and status = 'fetching')::int as pages_fetching,
       (select count(*) from frontier where crawl_id = $1 and status = 'done')::int as pages_done,
       (select count(*) from frontier where crawl_id = $1 and status = 'failed')::int as pages_failed,
       (select count(*) from frontier where crawl_id = $1 and status = 'failed' and http_status in (404, 410))::int as pages_broken,
       (select count(*) from frontier where crawl_id = $1 and status = 'skipped')::int as pages_skipped,
       (select count(*) from link_scores where crawl_id = $1 and target_score >= 0.5)::int as results,
       (select count(*) from link_scores s join links l on l.id = s.link_id
          where s.crawl_id = $1 and s.target_score >= 0.5 and l.type = 'document')::int as documents,
       (select count(*) from contacts where crawl_id = $1)::int as contacts,
       (select array_agg(url) from frontier where crawl_id = $1 and status = 'fetching') as now_fetching`,
    [crawlId],
  );
  return r.rows[0] as {
    pages_queued: number;
    pages_fetching: number;
    pages_done: number;
    pages_failed: number;
    /** Failed with 404 or 410: a broken link on the site. */
    pages_broken: number;
    pages_skipped: number;
    results: number;
    documents: number;
    contacts: number;
    now_fetching: string[] | null;
  };
}
