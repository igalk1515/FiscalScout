import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { type AppContext, createContext } from "../src/app.js";
import { hostOf, registrableDomain, urlHash } from "../src/crawler/url.js";
import type { Db } from "../src/db/client.js";
import { DEFAULT_KEYWORDS } from "../src/ranking/keywords.js";
import { createLlm, memoryCache } from "../src/ranking/llm.js";
import { RANKER_VERSION } from "../src/ranking/rules.js";
import * as repo from "../src/store/repo.js";
import { silentLog, testDb } from "./helpers/db.js";
import { type Handler, startServer } from "./helpers/server.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error("timed out");
}

/** A site with no end: every page answers slowly and links to eight more. */
function endlessSite(): Record<string, Handler> {
  const page: Handler = (req, res) => {
    const n = Number((req.url ?? "/").split("/").pop()) || 0;
    const links = Array.from({ length: 8 }, (_, i) => `<a href="/p/${n * 10 + i + 1}">Section ${n * 10 + i + 1}</a>`).join(" ");
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><title>Page ${n}</title></head><body><h1>Page ${n}</h1><p>${"Text about the city. ".repeat(30)}</p>${links}</body></html>`);
    }, 60);
  };
  return new Proxy({ "/robots.txt": (_q, r) => r.writeHead(404).end() } as Record<string, Handler>, {
    get: (routes, path: string) => routes[path] ?? (path === "/" || path.startsWith("/p/") ? page : undefined),
  });
}

let db: Db;
let ctx: AppContext;
let app: FastifyInstance;
let site: Awaited<ReturnType<typeof startServer>>;
const contexts: AppContext[] = [];

const contextFor = () =>
  createContext({
    db,
    log: silentLog,
    llm: createLlm({ model: "none", baseUrl: "http://unused", cache: memoryCache() }),
    config: { CRAWL_WORKERS: 2, MIN_HOST_DELAY_MS: 20, RAW_DIR: mkdtempSync(join(tmpdir(), "raw-")) },
  });

const frontier = async (id: string) =>
  (await db.query<{ status: string; reason: string | null; n: number }>(
    "select status, reason, count(*)::int as n from frontier where crawl_id = $1 group by 1, 2",
    [id],
  )).rows;
const eventTypes = async (id: string) =>
  (await db.query<{ type: string }>("select type from crawl_events where crawl_id = $1 order by id", [id])).rows.map((r) => r.type);

beforeAll(async () => {
  db = await testDb();
  site = await startServer(endlessSite());
  ctx = await contextFor();
  contexts.push(ctx);
  app = await buildServer(ctx);
});

afterAll(async () => {
  await app?.close();
  for (const c of contexts) await c.close();
  await site?.close();
  await db?.end();
});

describe("POST /v1/crawls/:id/cancel", () => {
  it("stops a running crawl: nothing new is fetched, the queue is skipped, the end is announced once", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/crawls", payload: { url: `${site.url}/`, max_depth: 5, page_budget: 300 } });
    const id = res.json().id;
    const live: { type: string; data: Record<string, unknown> }[] = [];
    const unsubscribe = ctx.events.subscribe(id, (e) => live.push({ type: e.type, data: e.data }));
    const running = ctx.runner.start(id); // the run the API started
    await waitFor(async () => (await frontier(id)).some((r) => r.status === "done" && r.n >= 3));

    const cancel = await app.inject({ method: "POST", url: `/v1/crawls/${id}/cancel` });
    expect(cancel.statusCode).toBe(202);
    expect(cancel.json()).toMatchObject({ id, status: "cancelled" });

    await running; // pages being fetched finish, then the run ends
    const hits = site.hits.length;
    await sleep(300);
    expect(site.hits.length).toBe(hits); // nothing more is fetched

    const rows = await frontier(id);
    expect(rows.filter((r) => r.status === "queued" || r.status === "fetching")).toEqual([]);
    expect(rows.find((r) => r.reason === "crawl cancelled")?.n).toBeGreaterThan(0);
    const done = rows.filter((r) => r.status === "done").reduce((a, r) => a + r.n, 0);
    expect(done).toBeLessThan(100);

    const crawl = (await app.inject({ method: "GET", url: `/v1/crawls/${id}` })).json();
    expect(crawl.status).toBe("cancelled");
    expect(crawl.status_detail).toMatch(/^cancelled by request after \d+ pages$/);
    expect(crawl.finished_at).not.toBeNull();

    const types = await eventTypes(id);
    expect(types.filter((t) => t === "crawl.cancelled")).toHaveLength(1);
    expect(types).not.toContain("crawl.done");
    expect(types.filter((t) => t.startsWith("crawl.")).pop()).toBe("crawl.cancelled");
    // The final counters go out before the end, with nothing left in the queue.
    unsubscribe();
    const end = live.findIndex((e) => e.type === "crawl.cancelled");
    const lastStats = live.slice(0, end).filter((e) => e.type === "stats").pop();
    expect(lastStats?.data).toMatchObject({ pages_queued: 0, pages_fetching: 0 });
    expect(lastStats?.data.pages_skipped).toBeGreaterThan(0);
  });

  it("answers 409 once the crawl has ended and 404 for an unknown crawl; results stay readable", async () => {
    const [crawl] = await repo.listCrawls(db, 1);
    const again = await app.inject({ method: "POST", url: `/v1/crawls/${crawl!.id}/cancel` });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatchObject({ code: "conflict", message: "the crawl already ended: cancelled" });
    const unknown = await app.inject({ method: "POST", url: "/v1/crawls/00000000-0000-4000-8000-000000000000/cancel" });
    expect(unknown.statusCode).toBe(404);
    const pages = await app.inject({ method: "GET", url: `/v1/crawls/${crawl!.id}/pages?status=done&limit=5` });
    expect(pages.json().data.length).toBeGreaterThan(0);
  });

  it("closes the event stream with crawl.cancelled", async () => {
    const [crawl] = await repo.listCrawls(db, 1);
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const text = await (await fetch(`${address}/v1/crawls/${crawl!.id}/events`)).text(); // ends because the crawl is over
    expect(text).toContain("event: crawl.cancelled");
  });

  it("cancels a queued crawl that nothing runs, and a later start does nothing", async () => {
    const seed = `${site.url}/p/5`;
    const { crawl } = await repo.createCrawl(
      db,
      { seedUrl: seed, keywords: DEFAULT_KEYWORDS, maxDepth: 2, pageBudget: 20, scopeDomain: registrableDomain(hostOf(seed)), rankerVersion: RANKER_VERSION },
      { hash: urlHash(seed), host: hostOf(seed) },
    );
    const res = await app.inject({ method: "POST", url: `/v1/crawls/${crawl.id}/cancel` });
    expect(res.statusCode).toBe(202);
    expect(res.json().status_detail).toBe("cancelled by request after 0 pages");
    expect(await frontier(crawl.id)).toEqual([{ status: "skipped", reason: "crawl cancelled", n: 1 }]);

    const hits = site.hits.length;
    await ctx.runner.start(crawl.id);
    expect(site.hits.length).toBe(hits);
    expect((await eventTypes(crawl.id)).filter((t) => t === "crawl.cancelled")).toHaveLength(1);
  });

  it("stops a crawl that runs in another process, through its heartbeat", async () => {
    const other = await contextFor(); // a second worker process, sharing only the database
    contexts.push(other);
    const seed = `${site.url}/p/7`;
    const { crawl } = await repo.createCrawl(
      db,
      { seedUrl: seed, keywords: DEFAULT_KEYWORDS, maxDepth: 5, pageBudget: 300, scopeDomain: registrableDomain(hostOf(seed)), rankerVersion: RANKER_VERSION },
      { hash: urlHash(seed), host: hostOf(seed) },
    );
    const running = other.runner.start(crawl.id);
    await waitFor(async () => (await frontier(crawl.id)).some((r) => r.status === "done" && r.n >= 3));

    const res = await app.inject({ method: "POST", url: `/v1/crawls/${crawl.id}/cancel` }); // through this process's API
    expect(res.statusCode).toBe(202);
    expect(ctx.runner.isRunning(crawl.id)).toBe(false);
    await running; // the other process sees it within a heartbeat and stops
    const rows = await frontier(crawl.id);
    expect(rows.filter((r) => r.status === "queued" || r.status === "fetching")).toEqual([]);
    expect(rows.filter((r) => r.status === "done").reduce((a, r) => a + r.n, 0)).toBeLessThan(100);
    expect((await eventTypes(crawl.id)).filter((t) => t === "crawl.cancelled")).toHaveLength(1);
  });
});
