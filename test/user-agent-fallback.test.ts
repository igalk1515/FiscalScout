import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppContext, createContext, startCrawl } from "../src/app.js";
import { userAgent } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import { createLlm, memoryCache } from "../src/ranking/llm.js";
import * as repo from "../src/store/repo.js";
import { silentLog, testDb } from "./helpers/db.js";
import { html, startServer, text } from "./helpers/server.js";

let db: Db;
let ctx: AppContext;
beforeAll(async () => {
  db = await testDb();
  ctx = await createContext({
    db,
    log: silentLog,
    llm: createLlm({ model: "none", baseUrl: "http://unused", cache: memoryCache() }),
    config: { CRAWL_WORKERS: 1, MIN_HOST_DELAY_MS: 0, RAW_DIR: mkdtempSync(join(tmpdir(), "agent-raw-")) },
  });
});
afterAll(async () => {
  await ctx?.close();
  await db?.end();
});

describe("crawler User-Agent fallback", () => {
  it.each([true, false])("recovers public pages while applying respectRobots=%s", async (respectRobots) => {
    const site = await startServer({
      "/robots.txt": text("User-agent: *\nDisallow: /private\n"),
      "/": (req, res) => {
        if (req.headers["user-agent"] === userAgent) return html("Access Denied", 403)(req, res);
        html('<a href="/finance">Finance</a><a href="/private/budget">Budget drafts</a>')(req, res);
      },
      "/finance": html('<h1>Budget</h1><a href="/fy2026-adopted-budget.pdf">FY2026 adopted budget</a>'),
      "/private/budget": html("<h1>Draft budget</h1>"),
    });
    try {
      const { crawl } = await startCrawl(ctx, { url: site.url, maxDepth: 1, pageBudget: 10, respectRobots, useLlm: false });
      await ctx.runner.start(crawl.id);
      expect((await repo.getCrawl(db, crawl.id))!.status).toBe("done");
      expect(site.hits.filter(path => path === "/")).toHaveLength(2);
      expect(site.hits.includes("/finance")).toBe(true);
      expect(site.hits.includes("/private/budget")).toBe(!respectRobots);
      const events = await db.query("select data from crawl_events where crawl_id = $1 and type = 'page.retrying'", [crawl.id]);
      expect(events.rows).toHaveLength(1);
      expect(events.rows[0].data.status).toBe(403);
      const results = await db.query("select doc_type from link_scores where crawl_id = $1 and doc_type = 'budget'", [crawl.id]);
      expect(results.rows.length).toBeGreaterThan(0);
    } finally {
      await site.close();
    }
  });

  it("honors robots rules for the standard client before using the fallback", async () => {
    const site = await startServer({
      "/robots.txt": text("User-agent: node\nDisallow: /\n\nUser-agent: *\nAllow: /\n"),
      "/": (req, res) => html("Public page", req.headers["user-agent"] === userAgent ? 403 : 200)(req, res),
    });
    try {
      const { crawl } = await startCrawl(ctx, { url: site.url, respectRobots: true, useLlm: false });
      await ctx.runner.start(crawl.id);
      expect((await repo.getCrawl(db, crawl.id))!.status).toBe("blocked");
      expect(site.hits).toEqual(["/robots.txt", "/"]);
      const rows = await db.query("select status, reason from frontier where crawl_id = $1", [crawl.id]);
      expect(rows.rows[0]).toEqual({ status: "skipped", reason: "robots.txt (standard HTTP client)" });
    } finally {
      await site.close();
    }
  });

  it("refreshes an old cached robots 403 and enforces the newly accessible rules", async () => {
    const site = await startServer({
      "/robots.txt": (req, res) => {
        if (req.headers["user-agent"] === userAgent) return text("Access Denied", 403)(req, res);
        text("User-agent: *\nDisallow: /\n")(req, res);
      },
      "/": html("<h1>Finance</h1>"),
    });
    try {
      const first = await startCrawl(ctx, { url: site.url, maxDepth: 0, respectRobots: false, useLlm: false });
      await ctx.runner.start(first.crawl.id);
      await repo.saveRobots(db, new URL(site.url).host, 403, null, undefined);
      const second = await startCrawl(ctx, { url: site.url, maxDepth: 0, respectRobots: true, useLlm: false });
      await ctx.runner.start(second.crawl.id);
      expect((await repo.getCrawl(db, second.crawl.id))!.status).toBe("blocked");
      expect(site.hits).toEqual(["/", "/robots.txt", "/robots.txt"]);
      expect((await repo.getRobots(db, new URL(site.url).host))!.status).toBe(200);
    } finally {
      await site.close();
    }
  });
});
