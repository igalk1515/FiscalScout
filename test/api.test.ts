import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { type AppContext, createContext } from "../src/app.js";
import type { Db } from "../src/db/client.js";
import { urlHash } from "../src/crawler/url.js";
import { DEFAULT_KEYWORDS } from "../src/ranking/keywords.js";
import { createLlm, memoryCache } from "../src/ranking/llm.js";
import { RANKER_VERSION } from "../src/ranking/rules.js";
import * as repo from "../src/store/repo.js";
import { startCitySite } from "./helpers/city-site.js";
import { silentLog, testDb } from "./helpers/db.js";

let db: Db;
let ctx: AppContext;
let app: FastifyInstance;
let site: Awaited<ReturnType<typeof startCitySite>>;
let crawlId: string;

beforeAll(async () => {
  db = await testDb();
  site = await startCitySite();
  ctx = await createContext({
    db,
    log: silentLog,
    llm: createLlm({ model: "none", baseUrl: "http://unused", cache: memoryCache() }),
    config: { CRAWL_WORKERS: 2, MIN_HOST_DELAY_MS: 30, RAW_DIR: mkdtempSync(join(tmpdir(), "raw-")) },
  });
  app = await buildServer(ctx);
  const res = await app.inject({ method: "POST", url: "/v1/crawls", payload: { url: `${site.url}/`, max_depth: 3, page_budget: 40, ranker: "rules" } });
  crawlId = res.json().id;
  await ctx.runner.start(crawlId);
});

afterAll(async () => {
  await app?.close();
  await ctx?.close();
  await site?.close();
  await db?.end();
});

describe("POST /v1/crawls", () => {
  it("answers 202 with the crawl, its counters and its links", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/crawls", payload: { url: `${site.url}/finance`, max_depth: 0 } });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body).toMatchObject({ status: "queued", max_depth: 0, page_budget: 300, respect_robots: true, use_llm: false });
    expect(body.links.live).toBe(`/live/${body.id}`);
    expect(res.headers.location).toBe(`/v1/crawls/${body.id}`);
    await ctx.runner.start(body.id);
  });

  it("validates input with one error shape", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/crawls", payload: { url: "not a url" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: "invalid_parameter", param: "url" });
    const bad = await app.inject({
      method: "POST",
      url: "/v1/crawls",
      payload: { url: `${site.url}/`, keywords: { budget: { weight: 3 } } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.param).toBe("keywords.budget.weight");
  });

  it.each(["respect_robots", "use_llm"])("rejects a non-boolean %s option", async (option) => {
    const res = await app.inject({ method: "POST", url: "/v1/crawls", payload: { url: `${site.url}/`, [option]: "false" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.param).toBe(option);
  });

  it("replays the same crawl for the same Idempotency-Key", async () => {
    const send = () =>
      app.inject({ method: "POST", url: "/v1/crawls", headers: { "idempotency-key": "k-1" }, payload: { url: `${site.url}/poverty`, max_depth: 0 } });
    const a = await send();
    const b = await send();
    expect(b.json().id).toBe(a.json().id);
    expect(b.headers["idempotent-replayed"]).toBe("true");
    await ctx.runner.start(a.json().id);
  });
});

describe("reading results", () => {
  it("GET /v1/crawls/:id shows the finished crawl and its counters", async () => {
    const res = await app.inject({ url: `/v1/crawls/${crawlId}` });
    expect(res.statusCode).toBe(200);
    const c = res.json();
    expect(c.status).toBe("done");
    expect(c.counters.pages_done).toBeGreaterThan(5);
    expect(c.counters.contacts).toBe(1);
    expect(c.counters.pages_broken).toBe(1);
  });

  it("GET /v1/crawls/:id/pages?status=broken lists the broken link and the page it was found on", async () => {
    const res = await app.inject({ url: `/v1/crawls/${crawlId}/pages?status=broken` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([
      expect.objectContaining({ url: `${site.url}/missing`, status: "failed", http_status: 404, parent_url: `${site.url}/` }),
    ]);
  });

  it("GET /v1/links returns ranked links with sources, and filters by type and doc_type", async () => {
    const res = await app.inject({ url: `/v1/links?crawl_id=${crawlId}&type=document&min_score=0.5` });
    expect(res.statusCode).toBe(200);
    const { data, crawl } = res.json();
    expect(crawl.id).toBe(crawlId);
    expect(data.length).toBeGreaterThanOrEqual(3);
    const scores = data.map((d: { target_score: number }) => d.target_score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(data.every((d: { type: string }) => d.type === "document")).toBe(true);
    const acfr = data.find((d: { url: string }) => d.url.endsWith("city-acfr-2025.pdf"));
    expect(acfr.sources[0]).toMatchObject({ anchor_text: "Fiscal Year 2025", section_heading: "Annual Comprehensive Financial Report (ACFR)" });
    expect(acfr.reason).toMatch(/heading/);

    const budgets = await app.inject({ url: `/v1/links?crawl_id=${crawlId}&doc_type=budget` });
    expect(budgets.json().data.every((d: { doc_type: string }) => d.doc_type === "budget")).toBe(true);
  });

  it("reads the latest crawl of a host when no crawl_id is given", async () => {
    const latest = (await app.inject({ url: "/v1/crawls?limit=1" })).json().data[0];
    const res = await app.inject({ url: `/v1/links?host=127.0.0.1&limit=1` });
    expect(res.statusCode).toBe(200);
    expect(res.json().crawl.id).toBe(latest.id);
  });

  it("pages with a cursor, without repeats", async () => {
    const all = (await app.inject({ url: `/v1/links?crawl_id=${crawlId}&limit=100` })).json().data.map((d: { id: number }) => d.id);
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const res = await app.inject({ url: `/v1/links?crawl_id=${crawlId}&limit=2${cursor ? `&cursor=${cursor}` : ""}` });
      const body: { data: { id: number }[]; next_cursor: string | null } = res.json();
      seen.push(...body.data.map((d: { id: number }) => d.id));
      cursor = body.next_cursor;
    } while (cursor);
    expect(seen).toEqual(all);
  });

  it("GET /v1/links/:id lists every sighting", async () => {
    const first = (await app.inject({ url: `/v1/links?crawl_id=${crawlId}&limit=1` })).json().data[0];
    const res = await app.inject({ url: `/v1/links/${first.id}?crawl_id=${crawlId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().sources.length).toBeGreaterThanOrEqual(1);
  });

  it("full-text search finds links by their words", async () => {
    const res = await app.inject({ url: `/v1/links?crawl_id=${crawlId}&q=adopted` });
    expect(res.json().data.some((d: { url: string }) => d.url.endsWith("fy2026-adopted-budget.pdf"))).toBe(true);
  });

  it("GET /v1/contacts returns the contact with its source", async () => {
    const res = await app.inject({ url: `/v1/contacts?crawl_id=${crawlId}` });
    expect(res.json().data[0]).toMatchObject({ name: "Jane Doe", title: "Finance Director", email: "jdoe@example.gov" });
    expect(res.json().data[0].source_snippet).toContain("Jane Doe");
  });

  it("GET /v1/crawls/:id/pages explains every skip", async () => {
    const res = await app.inject({ url: `/v1/crawls/${crawlId}/pages?status=skipped` });
    const reasons = res.json().data.map((p: { reason: string }) => p.reason);
    expect(reasons).toContain("robots.txt");
    expect(reasons.some((r: string) => r.startsWith("trap:"))).toBe(true);
  });

  it("asks for crawl_id or host, and answers 404 for unknown ids", async () => {
    expect((await app.inject({ url: "/v1/links" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/v1/crawls/00000000-0000-0000-0000-000000000000" })).statusCode).toBe(404);
    const nope = await app.inject({ url: "/nope" });
    expect(nope.json().error.code).toBe("not_found");
  });

  it("serves the OpenAPI document and the pages", async () => {
    const spec = (await app.inject({ url: "/docs/json" })).json();
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(["/v1/crawls", "/v1/links", "/v1/contacts", "/v1/crawls/{id}/events"]));
    expect((await app.inject({ url: `/live/${crawlId}` })).body).toContain("EventSource");
    expect((await app.inject({ url: "/" })).statusCode).toBe(200);
    const design = await app.inject({ url: "/architecture" });
    expect(design.statusCode).toBe(200);
    expect(design.body).toContain("<title>");
  });
});

describe("GET /v1/crawls/:id/events", () => {
  it("streams the stored history as Server-Sent Events and closes when the crawl is over", async () => {
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const res = await fetch(`${address}/v1/crawls/${crawlId}/events`);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const text = await res.text(); // the stream ends because the crawl is finished
    expect(text).toContain("event: crawl.started");
    expect(text).toContain("event: page.fetched");
    expect(text).toContain("event: crawl.done");
    expect(text).toMatch(/^id: \d+$/m);
  });

  it("resumes after Last-Event-ID", async () => {
    const address = app.server.address() as { port: number };
    const all = await (await fetch(`http://127.0.0.1:${address.port}/v1/crawls/${crawlId}/events`)).text();
    const ids = [...all.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    const mid = ids[Math.floor(ids.length / 2)]!;
    const rest = await (await fetch(`http://127.0.0.1:${address.port}/v1/crawls/${crawlId}/events`, { headers: { "last-event-id": String(mid) } })).text();
    const restIds = [...rest.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(restIds[0]).toBeGreaterThan(mid);
    expect(restIds).toEqual(ids.filter((i) => i > mid));
  });
});

describe("searching results and adjusting keywords", () => {
  it("GET /v1/keywords returns the defaults, with the related titles of the contact group", async () => {
    const res = await app.inject({ url: "/v1/keywords" });
    expect(res.statusCode).toBe(200);
    const d = res.json().default;
    expect(Object.keys(d)).toEqual(expect.arrayContaining(["acfr", "budget", "finance director"]));
    expect(d["finance director"].related).toEqual(expect.arrayContaining(["payroll", "purchasing"]));
  });

  it("GET /v1/contacts searches the name, title and email, and filters by keyword group", async () => {
    const ask = async (qs: string) => (await app.inject({ url: `/v1/contacts?crawl_id=${crawlId}&${qs}` })).json().data.map((c: { name: string }) => c.name);
    expect(await ask("q=jane")).toEqual(["Jane Doe"]);
    expect(await ask("q=doe+finance")).toEqual(["Jane Doe"]); // every word must match somewhere
    expect(await ask("q=jdoe%40example")).toEqual(["Jane Doe"]);
    expect(await ask("q=payroll")).toEqual([]);
    expect(await ask("keyword=finance+director")).toEqual(["Jane Doe"]);
    expect(await ask("keyword=budget")).toEqual([]);
  });

  it("GET /v1/links?keyword= matches the keyword group, not only the exact word", async () => {
    const res = await app.inject({ url: `/v1/links?crawl_id=${crawlId}&keyword=acfr&type=document` });
    const urls = res.json().data.map((d: { url: string }) => d.url);
    expect(urls.some((u: string) => u.endsWith("city-acfr-2025.pdf"))).toBe(true);
  });

  it("POST /v1/crawls/:id/rescore re-ranks from saved pages with new weights, and keeps them", async () => {
    const before = (await app.inject({ url: `/v1/links?crawl_id=${crawlId}&doc_type=budget&min_score=0.5` })).json().data;
    expect(before.length).toBeGreaterThan(0);
    // Budget no longer counts: budgets drop out, the ACFR stays.
    const keywords = { ...DEFAULT_KEYWORDS, budget: { ...DEFAULT_KEYWORDS.budget!, weight: 0 } };
    const res = await app.inject({ method: "POST", url: `/v1/crawls/${crawlId}/rescore`, payload: { keywords } });
    expect(res.statusCode).toBe(200);
    expect(res.json().rescored.pages).toBeGreaterThan(5);
    expect(res.json().crawl.keywords.budget.weight).toBe(0);
    const after = (await app.inject({ url: `/v1/links?crawl_id=${crawlId}&doc_type=budget&min_score=0.5` })).json().data;
    expect(after).toHaveLength(0);
    const acfr = (await app.inject({ url: `/v1/links?crawl_id=${crawlId}&doc_type=acfr&min_score=0.5` })).json().data;
    expect(acfr.length).toBeGreaterThan(0);
    // And back to the defaults: the budgets return.
    await app.inject({ method: "POST", url: `/v1/crawls/${crawlId}/rescore`, payload: { keywords: DEFAULT_KEYWORDS } });
    const back = (await app.inject({ url: `/v1/links?crawl_id=${crawlId}&doc_type=budget&min_score=0.5` })).json().data;
    expect(back.map((d: { url: string }) => d.url).sort()).toEqual(before.map((d: { url: string }) => d.url).sort());
  });

  it("answers 409 for a crawl that is still running, 400 for bad keywords", async () => {
    const seed = "http://running.example/";
    const { crawl } = await repo.createCrawl(
      db,
      { seedUrl: seed, keywords: DEFAULT_KEYWORDS, maxDepth: 1, pageBudget: 5, scopeDomain: "running.example", rankerVersion: RANKER_VERSION, idempotencyKey: null },
      { hash: urlHash(seed), host: "running.example" },
    );
    await repo.setCrawlStatus(db, crawl.id, "running");
    const busy = await app.inject({ method: "POST", url: `/v1/crawls/${crawl.id}/rescore`, payload: {} });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.code).toBe("conflict");
    await repo.setCrawlStatus(db, crawl.id, "failed", "test crawl");
    const bad = await app.inject({ method: "POST", url: `/v1/crawls/${crawlId}/rescore`, payload: { keywords: { budget: { weight: 3 } } } });
    expect(bad.statusCode).toBe(400);
  });

  it("serves the results page and the keyword editor, and nothing else from /assets", async () => {
    expect((await app.inject({ url: `/results/${crawlId}` })).body).toContain("Keywords, weights and ranking");
    const js = await app.inject({ url: "/assets/keywords.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toMatch(/javascript/);
    expect((await app.inject({ url: "/assets/..%2Fpackage.json" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/assets/index.html" })).statusCode).toBe(404);
  });
});
