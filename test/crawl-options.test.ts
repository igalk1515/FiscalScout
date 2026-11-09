import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/api/server.js";
import { type AppContext, createContext, startCrawl } from "../src/app.js";
import type { Db } from "../src/db/client.js";
import * as repo from "../src/store/repo.js";
import { silentLog, testDb } from "./helpers/db.js";
import { html, redirect, startServer, text } from "./helpers/server.js";

let db: Db;
let ctx: AppContext;
let app: FastifyInstance;
const llm = {
  enabled: true,
  model: "test-model",
  classifyLinks: vi.fn(async () => null),
  extractContacts: vi.fn(async () => null),
};

beforeAll(async () => {
  db = await testDb();
  ctx = await createContext({
    db,
    log: silentLog,
    llm,
    config: { CRAWL_WORKERS: 1, MIN_HOST_DELAY_MS: 0, RENDER_JS: false, RAW_DIR: mkdtempSync(join(tmpdir(), "options-raw-")) },
  });
  app = await buildServer(ctx);
});

afterAll(async () => {
  await app?.close();
  await ctx?.close();
  await db?.end();
});

describe("per-crawl options", () => {
  it.each([true, false])("applies respect_robots=%s to direct requests and redirect targets", async (respectRobots) => {
    const site = await startServer({
      "/robots.txt": text("User-agent: *\nDisallow: /private\n"),
      "/": html('<a href="/private/budget">Budget</a><a href="/old-budget">Budget archive</a>'),
      "/private/budget": html("<h1>Budget</h1>"),
      "/old-budget": redirect("/private/archive"),
      "/private/archive": html("<h1>Budget archive</h1>"),
    });
    try {
      const { crawl } = await startCrawl(ctx, { url: site.url, maxDepth: 1, respectRobots, useLlm: false });
      await ctx.runner.start(crawl.id);
      expect((await repo.getCrawl(db, crawl.id))!.status).toBe("done");
      expect(site.hits.includes("/robots.txt")).toBe(respectRobots);
      expect(site.hits.includes("/private/budget")).toBe(!respectRobots);
      expect(site.hits.includes("/private/archive")).toBe(!respectRobots);
    } finally {
      await site.close();
    }
  });

  it("keeps robots enabled by default and lets a later crawl opt out of a cached denial", async () => {
    const site = await startServer({
      "/robots.txt": text("User-agent: *\nDisallow: /\n"),
      "/": html("<h1>Finance</h1>"),
    });
    try {
      const first = await startCrawl(ctx, { url: site.url, maxDepth: 0 });
      await ctx.runner.start(first.crawl.id);
      expect((await repo.getCrawl(db, first.crawl.id))!.status).toBe("blocked");
      expect(site.hits).toEqual(["/robots.txt"]);
      const second = await startCrawl(ctx, { url: site.url, maxDepth: 0, respectRobots: false });
      await ctx.runner.start(second.crawl.id);
      expect((await repo.getCrawl(db, second.crawl.id))!.status).toBe("done");
      expect(site.hits).toEqual(["/robots.txt", "/"]);
    } finally {
      await site.close();
    }
  });

  it.each(["meta", "header", "link"])("applies the robots switch to %s nofollow directives", async (directive) => {
    const site = await startServer({
      "/robots.txt": text("User-agent: *\nAllow: /\n"),
      "/": (_req, res) => {
        res.writeHead(200, { "content-type": "text/html", ...(directive === "header" ? { "x-robots-tag": "nofollow" } : {}) });
        res.end(`<!doctype html><html><head>${directive === "meta" ? '<meta name="robots" content="nofollow">' : ""}</head>
          <body><a href="/finance" ${directive === "link" ? 'rel="nofollow"' : ""}>Finance</a></body></html>`);
      },
      "/finance": html("<h1>Finance</h1>"),
    });
    try {
      for (const respectRobots of [true, false]) {
        const before = site.hits.length;
        const { crawl } = await startCrawl(ctx, { url: site.url, maxDepth: 1, respectRobots, useLlm: false });
        await ctx.runner.start(crawl.id);
        expect(site.hits.slice(before).includes("/finance")).toBe(!respectRobots);
      }
    } finally {
      await site.close();
    }
  });

  it.each([
    { respect_robots: true, use_llm: true },
    { respect_robots: true, use_llm: false },
    { respect_robots: false, use_llm: true },
    { respect_robots: false, use_llm: false },
  ])("persists $respect_robots/$use_llm through the API and gates both LLM features", async (options) => {
    const site = await startServer({
      "/robots.txt": text("User-agent: *\nAllow: /\n"),
      "/": html(`<a href="/annual-report">Annual financial report</a>
        <div><p>Jane Doe,<br>Finance Director</p><a href="mailto:jane@example.gov">Email Jane</a></div>`),
    });
    llm.classifyLinks.mockClear();
    llm.extractContacts.mockClear();
    try {
      const res = await app.inject({ method: "POST", url: "/v1/crawls", payload: { url: site.url, max_depth: 0, ...options } });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject(options);
      const id = res.json().id as string;
      await ctx.runner.start(id);
      const saved = (await app.inject({ url: `/v1/crawls/${id}` })).json();
      expect(saved).toMatchObject({ ...options, status: "done" });
      expect(llm.classifyLinks.mock.calls.length > 0).toBe(options.use_llm);
      expect(llm.extractContacts.mock.calls.length > 0).toBe(options.use_llm);
      const started = await db.query("select data from crawl_events where crawl_id = $1 and type = 'crawl.started'", [id]);
      expect(started.rows[0].data).toMatchObject({ respect_robots: options.respect_robots, llm: options.use_llm ? "test-model" : null });
      if (!options.use_llm) {
        expect(saved.counters).toMatchObject({ llm_calls: 0, llm_cost_usd: 0, contacts: 1 });
        const links = await db.query("select distinct decided_by from link_scores where crawl_id = $1", [id]);
        expect(links.rows).toEqual([{ decided_by: "rules" }]);
      }
    } finally {
      await site.close();
    }
  });
});
