import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { type AppContext, startCrawl } from "../app.js";
import { registrableDomain } from "../crawler/url.js";
import type { CrawlEvent } from "../events.js";
import * as repo from "../store/repo.js";
import {
  ContactsOut,
  ContactsQuery,
  CrawlOut,
  CrawlSummaryOut,
  CreateCrawlBody,
  decodeCursor,
  encodeCursor,
  ErrorOut,
  EventsQuery,
  IdParams,
  LinkOut,
  LinkQuery,
  LinksOut,
  LinksQuery,
  PagesOut,
  PagesQuery,
} from "./schemas.js";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../public");
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export class NotFound extends Error {}

async function crawlView(ctx: AppContext, c: repo.CrawlRow): Promise<z.infer<typeof CrawlOut>> {
  const k = await repo.crawlCounters(ctx.db, c.id);
  return {
    id: c.id,
    seed_url: c.seed_url,
    status: c.status,
    status_detail: c.status_detail,
    keywords: c.keywords,
    max_depth: c.max_depth,
    page_budget: c.page_budget,
    extra_hosts: c.extra_hosts,
    counters: {
      pages_done: k.pages_done,
      pages_queued: k.pages_queued,
      pages_fetching: k.pages_fetching,
      pages_failed: k.pages_failed,
      pages_skipped: k.pages_skipped,
      results: k.results,
      documents: k.documents,
      contacts: k.contacts,
      llm_calls: c.llm_calls,
      llm_cost_usd: c.llm_cost_usd,
    },
    now_fetching: k.now_fetching ?? [],
    created_at: c.created_at.toISOString(),
    started_at: iso(c.started_at),
    finished_at: iso(c.finished_at),
    links: {
      self: `/v1/crawls/${c.id}`,
      results: `/v1/links?crawl_id=${c.id}`,
      contacts: `/v1/contacts?crawl_id=${c.id}`,
      events: `/v1/crawls/${c.id}/events`,
      live: `/live/${c.id}`,
    },
  };
}

/** Scores belong to a crawl: use crawl_id, or the latest crawl of the host's site. */
async function resolveCrawl(ctx: AppContext, q: { crawl_id?: string; host?: string }): Promise<repo.CrawlRow> {
  const crawl = q.crawl_id
    ? await repo.getCrawl(ctx.db, q.crawl_id)
    : await repo.latestCrawlForDomain(ctx.db, registrableDomain(q.host!.replace(/^https?:\/\//, "").split("/")[0]!));
  if (!crawl) throw new NotFound(q.crawl_id ? "crawl not found" : `no crawl for ${q.host}`);
  return crawl;
}

export function registerRoutes(root: FastifyInstance, ctx: AppContext) {
  const app = root.withTypeProvider<ZodTypeProvider>();
  const errors = { 400: ErrorOut, 404: ErrorOut };

  app.post(
    "/v1/crawls",
    {
      schema: {
        tags: ["crawls"],
        summary: "Start a crawl",
        description:
          "Creates a crawl and starts it in the background. Answers 202 at once. Send an Idempotency-Key header to make retries safe: the same key returns the same crawl.",
        body: CreateCrawlBody,
        headers: z.object({ "idempotency-key": z.string().max(200).optional() }),
        response: { 202: CrawlOut, ...errors },
      },
    },
    async (req, reply) => {
      const { crawl, created } = await startCrawl(ctx, {
        url: req.body.url,
        keywords: req.body.keywords,
        maxDepth: req.body.max_depth,
        pageBudget: req.body.page_budget,
        idempotencyKey: req.headers["idempotency-key"] ?? null,
      });
      if (!created) reply.header("idempotent-replayed", "true");
      reply.header("location", `/v1/crawls/${crawl.id}`);
      return reply.status(202).send(await crawlView(ctx, crawl));
    },
  );

  app.get(
    "/v1/crawls",
    {
      schema: {
        tags: ["crawls"],
        summary: "List recent crawls",
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
        response: { 200: z.object({ data: z.array(CrawlSummaryOut) }) },
      },
    },
    async (req) => {
      const rows = await repo.listCrawls(ctx.db, req.query.limit);
      return {
        data: rows.map((c) => ({
          id: c.id,
          seed_url: c.seed_url,
          status: c.status,
          status_detail: c.status_detail,
          pages_fetched: c.pages_fetched,
          created_at: c.created_at.toISOString(),
          finished_at: iso(c.finished_at),
        })),
      };
    },
  );

  app.get(
    "/v1/crawls/:id",
    { schema: { tags: ["crawls"], summary: "Status and counters of a crawl", params: IdParams, response: { 200: CrawlOut, ...errors } } },
    async (req) => {
      const crawl = await repo.getCrawl(ctx.db, req.params.id);
      if (!crawl) throw new NotFound("crawl not found");
      return crawlView(ctx, crawl);
    },
  );

  app.get(
    "/v1/crawls/:id/pages",
    {
      schema: {
        tags: ["crawls"],
        summary: "Pages the crawl considered, by status, with the reason for each skip or failure",
        params: IdParams,
        querystring: PagesQuery,
        response: { 200: PagesOut, ...errors },
      },
    },
    async (req) => {
      const crawl = await repo.getCrawl(ctx.db, req.params.id);
      if (!crawl) throw new NotFound("crawl not found");
      const cur = decodeCursor<{ s: number; u: string }>(req.query.cursor);
      const r = await ctx.db.query(
        `select url, status, reason, http_status, depth, path_score, attempts, updated_at
         from frontier
         where crawl_id = $1 and ($2::text is null or status = $2)
           and ($3::real is null or (path_score, url) < ($3::real, $4::text))
         order by path_score desc, url desc
         limit $5`,
        [crawl.id, req.query.status ?? null, cur?.s ?? null, cur?.u ?? null, req.query.limit + 1],
      );
      const rows = r.rows.slice(0, req.query.limit);
      const last = rows[rows.length - 1];
      return {
        data: rows.map((x) => ({ ...x, updated_at: x.updated_at.toISOString() })),
        next_cursor: r.rows.length > req.query.limit && last ? encodeCursor({ s: last.path_score, u: last.url }) : null,
      };
    },
  );

  app.get(
    "/v1/links",
    {
      schema: {
        tags: ["results"],
        summary: "Ranked links of a crawl",
        description:
          "Sorted by target score, then newest fiscal year. Pass crawl_id, or host to read that site's latest crawl. Keyset pagination: pass next_cursor back as cursor.",
        querystring: LinksQuery,
        response: { 200: LinksOut, ...errors },
      },
    },
    async (req) => {
      const q = req.query;
      const crawl = await resolveCrawl(ctx, q);
      const cur = decodeCursor<{ s: number; f: number; id: number }>(q.cursor);
      const params: unknown[] = [crawl.id, q.min_score];
      const where = ["s.crawl_id = $1", "s.target_score >= $2"];
      const add = (sql: string, v: unknown) => {
        params.push(v);
        where.push(sql.replace("?", `$${params.length}`));
      };
      if (q.type) add("l.type = ?", q.type);
      if (q.doc_type) add("s.doc_type = ?", q.doc_type);
      if (q.fiscal_year) add("l.fiscal_year = ?", q.fiscal_year);
      if (q.keyword) add("? = any(s.matched_keywords)", q.keyword.toLowerCase());
      if (q.q) add("l.search @@ websearch_to_tsquery('simple', ?)", q.q);
      if (cur) {
        params.push(cur.s, cur.f, cur.id);
        const n = params.length;
        where.push(`(s.target_score, coalesce(l.fiscal_year, 0), -l.id) < ($${n - 2}::real, $${n - 1}::int, -$${n}::bigint)`);
      }
      params.push(q.limit + 1);
      const r = await ctx.db.query(
        `select l.id, l.url, l.label, l.type, l.file_type, s.doc_type, l.fiscal_year, l.is_draft, l.needs_browser,
                s.target_score, s.path_score, s.matched_keywords, s.decided_by, s.reason
         from link_scores s join links l on l.id = s.link_id
         where ${where.join(" and ")}
         order by s.target_score desc, coalesce(l.fiscal_year, 0) desc, l.id asc
         limit $${params.length}`,
        params,
      );
      const rows = r.rows.slice(0, q.limit);
      const sources = await sourcesFor(ctx, crawl.id, rows.map((x) => x.id), 3);
      const last = rows[rows.length - 1];
      return {
        crawl: { id: crawl.id, seed_url: crawl.seed_url, status: crawl.status },
        data: rows.map((x) => ({ ...x, sources: sources.get(x.id) ?? [] })),
        next_cursor:
          r.rows.length > q.limit && last ? encodeCursor({ s: last.target_score, f: last.fiscal_year ?? 0, id: last.id }) : null,
      };
    },
  );

  app.get(
    "/v1/links/:id",
    {
      schema: {
        tags: ["results"],
        summary: "One link with every place it was found",
        params: z.object({ id: z.coerce.number().int() }),
        querystring: LinkQuery,
        response: { 200: LinkOut, ...errors },
      },
    },
    async (req) => {
      const r = await ctx.db.query(
        `select l.id, l.url, l.label, l.type, l.file_type, s.doc_type, l.fiscal_year, l.is_draft, l.needs_browser,
                s.target_score, s.path_score, s.matched_keywords, s.decided_by, s.reason, s.crawl_id
         from links l join link_scores s on s.link_id = l.id
         join crawls c on c.id = s.crawl_id
         where l.id = $1 and ($2::uuid is null or s.crawl_id = $2)
         order by c.created_at desc limit 1`,
        [req.params.id, req.query.crawl_id ?? null],
      );
      const row = r.rows[0];
      if (!row) throw new NotFound("link not found");
      const sources = await sourcesFor(ctx, row.crawl_id, [row.id], 1000);
      const { crawl_id: _c, ...rest } = row;
      return { ...rest, sources: sources.get(row.id) ?? [] };
    },
  );

  app.get(
    "/v1/contacts",
    {
      schema: {
        tags: ["results"],
        summary: "Contacts found by a crawl",
        description: "Each contact keeps the page and the block of text every field was checked against.",
        querystring: ContactsQuery,
        response: { 200: ContactsOut, ...errors },
      },
    },
    async (req) => {
      const crawl = await resolveCrawl(ctx, req.query);
      const r = await ctx.db.query(
        `select id, name, title, email, phone, score, matched_keywords, source_url, source_snippet, decided_by
         from contacts
         where crawl_id = $1 and score >= $2 and ($3::text is null or title ilike '%' || $3 || '%')
         order by score desc, id asc limit $4`,
        [crawl.id, req.query.min_score, req.query.title ?? null, req.query.limit],
      );
      return { crawl: { id: crawl.id, seed_url: crawl.seed_url, status: crawl.status }, data: r.rows };
    },
  );

  app.get(
    "/v1/crawls/:id/events",
    {
      schema: {
        tags: ["crawls"],
        summary: "Live stream of the crawl (Server-Sent Events)",
        description:
          "text/event-stream. Sends the stored history first, then new events as they happen. Reconnects resume from Last-Event-ID. Event types: crawl.started, page.fetching, page.fetched, page.failed, page.skipped, link.found, contact.found, scope.added, host.paused, stats, crawl.done, crawl.blocked, crawl.failed.",
        params: IdParams,
        querystring: EventsQuery,
      },
    },
    async (req, reply) => {
      const crawl = await repo.getCrawl(ctx.db, req.params.id);
      if (!crawl) throw new NotFound("crawl not found");
      const after = Number(req.headers["last-event-id"] ?? req.query.after ?? 0) || 0;

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const send = (e: CrawlEvent) => {
        if (res.writableEnded) return;
        res.write(`${e.id ? `id: ${e.id}\n` : ""}event: ${e.type}\ndata: ${JSON.stringify({ ...e.data, at: e.at })}\n\n`);
      };

      // Subscribe before reading history, so nothing falls between the two.
      const buffered: CrawlEvent[] = [];
      let live = false;
      const finished = (type: string) => ["crawl.done", "crawl.blocked", "crawl.failed"].includes(type);
      const unsubscribe = ctx.events.subscribe(crawl.id, (e) => {
        if (!live) return void buffered.push(e);
        send(e);
        if (finished(e.type)) close();
      });
      const ping = setInterval(() => !res.writableEnded && res.write(": ping\n\n"), 15_000);
      const close = () => {
        clearInterval(ping);
        unsubscribe();
        if (!res.writableEnded) res.end();
      };
      req.raw.on("close", close);

      res.write("retry: 3000\n\n");
      let lastId = after;
      for (const e of await ctx.events.history(crawl.id, after, 5000)) {
        send(e);
        lastId = e.id ?? lastId;
      }
      for (const e of buffered) if (!e.id || e.id > lastId) send(e);
      live = true;
      const current = await repo.getCrawl(ctx.db, crawl.id);
      if (current && ["done", "blocked", "failed"].includes(current.status) && !ctx.runner.isRunning(crawl.id)) close();
    },
  );

  root.get("/live/:id", { schema: { hide: true } }, async (_req, reply) => {
    reply.type("text/html; charset=utf-8");
    return readFile(resolve(PUBLIC_DIR, "live.html"), "utf8");
  });

  root.get("/", { schema: { hide: true } }, async (_req, reply) => {
    reply.type("text/html; charset=utf-8");
    return readFile(resolve(PUBLIC_DIR, "index.html"), "utf8");
  });

  root.get("/health", { schema: { tags: ["system"], summary: "Liveness and database check" } }, async () => {
    await ctx.db.query("select 1");
    return { ok: true, llm: ctx.llm.enabled ? ctx.llm.model : null };
  });
}

async function sourcesFor(ctx: AppContext, crawlId: string, linkIds: number[], perLink: number) {
  const out = new Map<number, z.infer<typeof LinkOut>["sources"]>();
  if (!linkIds.length) return out;
  const r = await ctx.db.query(
    `select link_id, page, anchor_text, section_heading, context, found_at from (
       select g.link_id, coalesce(p.final_url, p.url) as page, g.anchor_text, g.section_heading, g.context_snippet as context,
              g.found_at, row_number() over (partition by g.link_id order by g.in_boilerplate, g.found_at) as n
       from sightings g join pages p on p.id = g.source_page_id
       where g.crawl_id = $1 and g.link_id = any($2::bigint[])
     ) t where n <= $3 order by link_id, n`,
    [crawlId, linkIds, perLink],
  );
  for (const row of r.rows) {
    const list = out.get(row.link_id) ?? [];
    list.push({ page: row.page, anchor_text: row.anchor_text, section_heading: row.section_heading, context: row.context, found_at: row.found_at.toISOString() });
    out.set(row.link_id, list);
  }
  return out;
}
