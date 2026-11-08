import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppContext, createContext, startCrawl } from "../src/app.js";
import type { Db } from "../src/db/client.js";
import { createLlm, memoryCache } from "../src/ranking/llm.js";
import * as repo from "../src/store/repo.js";
import { startCitySite } from "./helpers/city-site.js";
import { silentLog, testDb } from "./helpers/db.js";

let db: Db;
let ctx: AppContext;
let site: Awaited<ReturnType<typeof startCitySite>>;
let crawlId: string;

beforeAll(async () => {
  db = await testDb();
  site = await startCitySite();
  ctx = await createContext({
    db,
    log: silentLog,
    llm: createLlm({ model: "none", baseUrl: "http://unused", cache: memoryCache() }), // no key: rules only
    config: { CRAWL_WORKERS: 3, MIN_HOST_DELAY_MS: 30, RAW_DIR: mkdtempSync(join(tmpdir(), "raw-")) },
  });
  const { crawl } = await startCrawl(ctx, { url: `${site.url}/`, maxDepth: 3, pageBudget: 50 });
  crawlId = crawl.id;
  await ctx.runner.start(crawlId);
});

afterAll(async () => {
  await ctx?.close();
  await site?.close();
  await db?.end();
});

const frontier = async () =>
  (await db.query("select url, status, reason, http_status, attempts from frontier where crawl_id = $1", [crawlId])).rows as {
    url: string;
    status: string;
    reason: string | null;
    http_status: number | null;
    attempts: number;
  }[];
const row = async (path: string) => (await frontier()).find((r) => r.url === `${site.url}${path}`);

describe("crawler on a fake city site", () => {
  it("finishes and reports done", async () => {
    const crawl = await repo.getCrawl(db, crawlId);
    expect(crawl!.status).toBe("done");
    expect(crawl!.pages_fetched).toBeGreaterThanOrEqual(6);
  });

  it("respects robots.txt: the disallowed page is skipped and never requested", async () => {
    expect((await row("/private/budget-drafts"))?.reason).toBe("robots.txt");
    expect(site.hits.filter((h) => h.startsWith("/private"))).toHaveLength(0);
    expect(site.hits.filter((h) => h === "/robots.txt")).toHaveLength(1);
  });

  it("never sends two requests to the same host at once", () => {
    expect(site.maxActive()).toBe(1);
  });

  it("stops traps and stays in scope", async () => {
    expect((await row("/meetings/calendar?month=2031-04"))?.reason).toMatch(/^trap: calendar/);
    expect((await row("/a/b/a/b/a/b"))?.reason).toBe("trap: repeating path");
    expect(site.hits.some((h) => h.startsWith("/meetings") || h.startsWith("/a/b"))).toBe(false);
    expect((await frontier()).some((r) => r.url.includes("facebook.com"))).toBe(false); // noise is not even queued
  });

  it("retries a 503 and does not retry a 404", async () => {
    expect((await row("/flaky"))).toMatchObject({ status: "done", attempts: 2 });
    expect(site.flakyHits()).toBe(2);
    expect((await row("/missing"))).toMatchObject({ status: "failed", http_status: 404, attempts: 1 });
  });

  it("follows the redirect and records the page once", async () => {
    expect((await row("/old-finance"))?.status).toBe("done");
    const pages = await db.query("select final_url from pages where url = $1", [`${site.url}/old-finance`]);
    expect(pages.rows[0].final_url).toBe(`${site.url}/finance/reports`);
  });

  it("ranks the ACFR and the budget as results, with provenance", async () => {
    const r = await db.query(
      `select l.url, l.type, l.file_type, l.fiscal_year, s.doc_type, s.target_score, g.section_heading, g.anchor_text
       from link_scores s join links l on l.id = s.link_id
       join sightings g on g.link_id = l.id and g.crawl_id = s.crawl_id
       where s.crawl_id = $1 order by s.target_score desc`,
      [crawlId],
    );
    const acfr = r.rows.find((x) => x.url.endsWith("city-acfr-2025.pdf"));
    expect(acfr).toMatchObject({ doc_type: "acfr", fiscal_year: 2025, anchor_text: "Fiscal Year 2025" });
    expect(acfr.section_heading).toBe("Annual Comprehensive Financial Report (ACFR)");
    expect(acfr.target_score).toBeGreaterThanOrEqual(0.7);
    const budget = r.rows.find((x) => x.url.endsWith("fy2026-adopted-budget.pdf"));
    expect(budget).toMatchObject({ doc_type: "budget", fiscal_year: 2026 });
    expect(budget.target_score).toBeGreaterThanOrEqual(0.7);
  });

  it("learns that an opaque URL is a PDF when it fetches it", async () => {
    const r = await db.query("select type, file_type from links where url = $1", [`${site.url}/DocumentCenter/View/77`]);
    expect(r.rows[0]).toEqual({ type: "document", file_type: "pdf" });
  });

  it("finds the finance contact", async () => {
    const r = await db.query("select name, title, email from contacts where crawl_id = $1", [crawlId]);
    expect(r.rows).toContainEqual({ name: "Jane Doe", title: "Finance Director", email: "jdoe@example.gov" });
  });

  it("records events for the live view", async () => {
    const r = await db.query("select type, count(*)::int as n from crawl_events where crawl_id = $1 group by type", [crawlId]);
    const n = Object.fromEntries(r.rows.map((x) => [x.type, x.n]));
    expect(n["crawl.started"]).toBe(1);
    expect(n["crawl.done"]).toBe(1);
    expect(n["page.fetched"]).toBe((await frontier()).filter((f) => f.status === "done").length);
    expect(n["contact.found"]).toBe(1);
  });

  it("a second crawl adds no duplicate links, and keeps its own scores", async () => {
    const before = (await db.query("select count(*)::int as n from links")).rows[0].n;
    const { crawl } = await startCrawl(ctx, { url: `${site.url}/`, maxDepth: 3, pageBudget: 50 });
    await ctx.runner.start(crawl.id);
    const after = (await db.query("select count(*)::int as n from links")).rows[0].n;
    expect(after).toBe(before);
    const scores = await db.query("select crawl_id, count(*)::int as n from link_scores group by crawl_id");
    expect(scores.rows).toHaveLength(2);
    expect(scores.rows[0].n).toBe(scores.rows[1].n);
  });

  it("an idempotency key returns the same crawl", async () => {
    const a = await startCrawl(ctx, { url: `${site.url}/finance`, maxDepth: 0, idempotencyKey: "same-key" });
    const b = await startCrawl(ctx, { url: `${site.url}/finance`, maxDepth: 0, idempotencyKey: "same-key" });
    expect(b.crawl.id).toBe(a.crawl.id);
    expect(b.created).toBe(false);
    await ctx.runner.start(a.crawl.id);
  });
});

describe("leases and pauses", () => {
  it("runs a crawl in one runner only, even when two processes try", async () => {
    const { CrawlRunner } = await import("../src/crawler/runner.js");
    const second = new CrawlRunner({
      db,
      events: ctx.events,
      llm: ctx.llm,
      rawDir: ctx.config.RAW_DIR,
      userAgent: "test",
      robotsToken: "test",
      workers: 1,
      minDelayMs: 30,
      log: silentLog,
    });
    const { crawl } = await startCrawl(ctx, { url: `${site.url}/departments`, maxDepth: 1 });
    await Promise.all([ctx.runner.start(crawl.id), second.start(crawl.id)]);
    const started = await db.query("select count(*)::int as n from crawl_events where crawl_id = $1 and type = 'crawl.started'", [crawl.id]);
    expect(started.rows[0].n).toBe(1);
    expect((await repo.getCrawl(db, crawl.id))!.status).toBe("done");
  });

  it("a pause left by an earlier crawl ends, and a long pause does not hang a crawl", async () => {
    const host = new URL(site.url).host;
    await db.query("update hosts set paused_until = now() - interval '1 minute' where host = $1", [host]);
    const a = await startCrawl(ctx, { url: `${site.url}/finance/reports`, maxDepth: 0 });
    await ctx.runner.start(a.crawl.id);
    expect((await repo.getCrawl(db, a.crawl.id))!.status).toBe("done");

    await db.query("update hosts set paused_until = now() + interval '1 hour' where host = $1", [host]);
    const b = await startCrawl(ctx, { url: `${site.url}/poverty`, maxDepth: 0 });
    await ctx.runner.start(b.crawl.id);
    const done = await repo.getCrawl(db, b.crawl.id);
    expect(done!.status).toBe("failed");
    expect(done!.status_detail).toMatch(/paused/);
    await db.query("update hosts set paused_until = null where host = $1", [host]);
  });
});

describe("a blocked site", () => {
  it("is reported as blocked after one refused request, never bypassed", async () => {
    const { startServer, html, text } = await import("./helpers/server.js");
    const blocked = await startServer({
      "/robots.txt": text("forbidden", 403),
      "/": html("Access Denied", 403),
    });
    const { crawl } = await startCrawl(ctx, { url: `${blocked.url}/`, maxDepth: 2 });
    await ctx.runner.start(crawl.id);
    const done = await repo.getCrawl(db, crawl.id);
    expect(done!.status).toBe("blocked");
    expect(done!.status_detail).toMatch(/HTTP 403/);
    expect(blocked.hits).toEqual(["/robots.txt", "/"]);
    await blocked.close();
  });
});
