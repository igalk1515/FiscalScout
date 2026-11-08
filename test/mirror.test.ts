import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppContext, createContext } from "../src/app.js";
import { mirrorOf, unmirror, urlHash } from "../src/crawler/url.js";
import type { Db } from "../src/db/client.js";
import { createLlm, memoryCache } from "../src/ranking/llm.js";
import { DEFAULT_KEYWORDS } from "../src/ranking/keywords.js";
import { RANKER_VERSION } from "../src/ranking/rules.js";
import * as repo from "../src/store/repo.js";
import { silentLog, testDb } from "./helpers/db.js";

describe("mirror hosts, from canonical links", () => {
  const scope = { domain: "boerneisd.net", extraHosts: new Set(["boerneisd.smartsiteshost.com"]) };

  it("a page whose canonical is the same path on another in-scope host makes its host a mirror", () => {
    expect(mirrorOf("https://boerneisd.smartsiteshost.com/244573_3", "https://www.boerneisd.net/244573_3", scope)).toEqual({
      host: "boerneisd.smartsiteshost.com",
      origin: "https://www.boerneisd.net",
    });
    expect(mirrorOf("https://boerneisd.net/411496_2", "https://www.boerneisd.net/411496_2", scope)?.host).toBe("boerneisd.net");
  });

  it("is not fooled by a home page, a different path, the same host, or an out-of-scope canonical", () => {
    expect(mirrorOf("https://chs.boerneisd.net/", "https://www.boerneisd.net/", scope)).toBeNull();
    expect(mirrorOf("https://www.boerneisd.net/411496_2", "https://www.boerneisd.net/244573_3", scope)).toBeNull();
    expect(mirrorOf("https://boerneisd.net/a", "https://www.boerneisd.net/b", scope)).toBeNull();
    expect(mirrorOf("https://boerneisd.net/a", "https://other.example/a", scope)).toBeNull();
    expect(mirrorOf("https://boerneisd.net/a", null, scope)).toBeNull();
  });

  it("rewrites URLs on a mirror host to the original site, and leaves the rest alone", () => {
    const mirrors = new Map([["boerneisd.smartsiteshost.com", "https://www.boerneisd.net"]]);
    expect(unmirror("https://boerneisd.smartsiteshost.com/256834_3?x=1", mirrors)).toBe("https://www.boerneisd.net/256834_3?x=1");
    expect(unmirror("https://chs.boerneisd.net/page", mirrors)).toBe("https://chs.boerneisd.net/page");
  });
});

/**
 * One site served under two host names, 127.0.0.1 (the original) and localhost (the copy).
 * Every page names its 127.0.0.1 URL as canonical, like boerneisd.smartsiteshost.com does.
 */
describe("crawler on a site with a mirror host", () => {
  let db: Db;
  let ctx: AppContext;
  let server: Server;
  let crawlId: string;
  const hits: string[] = [];

  beforeAll(async () => {
    db = await testDb();
    server = createServer((req, res) => {
      hits.push(`${req.headers.host}${req.url}`);
      const port = (server.address() as AddressInfo).port;
      const original = `http://127.0.0.1:${port}`;
      const copy = `http://localhost:${port}`;
      const pages: Record<string, string> = {
        "/": `<a href="${copy}/finance">Finance Department</a> <a href="${copy}/budget">Budget</a> <a href="${copy}/staff">Staff directory</a>`,
        "/finance": `<h1>Finance Department</h1><a href="${copy}/budget">Budget documents</a> <a href="/reports">Financial Reports</a>`,
        "/budget": `<h1>Budget</h1><a href="${original}/reports">Annual reports</a>`,
        "/reports": `<h1>Financial Reports</h1><a href="${copy}/staff">Staff</a>`,
        "/staff": `<h1>Staff</h1><p>Finance office staff list.</p>`,
      };
      if (req.url === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      const body = pages[req.url ?? ""];
      if (!body) {
        res.writeHead(404, { "content-type": "text/html" });
        res.end("<html><body>not found</body></html>");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html><head><title>t</title><link rel="canonical" href="${original}${req.url}"></head>` +
          `<body>${body}<p>${"Words to make the page look like a real page. ".repeat(12)}</p><a href="/">Home</a> <a href="/staff">Staff</a></body></html>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    ctx = await createContext({
      db,
      log: silentLog,
      llm: createLlm({ model: "none", baseUrl: "http://unused", cache: memoryCache() }),
      config: { CRAWL_WORKERS: 3, MIN_HOST_DELAY_MS: 20, RAW_DIR: mkdtempSync(join(tmpdir(), "raw-")) },
    });
    // The copy's host joins the scope the way boerneisd.smartsiteshost.com does (its name).
    const seed = `http://127.0.0.1:${port}/`;
    const { crawl } = await repo.createCrawl(
      db,
      { seedUrl: seed, keywords: DEFAULT_KEYWORDS, maxDepth: 4, pageBudget: 50, scopeDomain: "127.0.0.1", rankerVersion: RANKER_VERSION, idempotencyKey: null },
      { hash: urlHash(seed), host: `127.0.0.1:${port}` },
    );
    crawlId = crawl.id;
    await repo.addExtraHost(db, crawlId, `localhost:${port}`);
    await ctx.runner.start(crawlId);
  });

  afterAll(async () => {
    await ctx?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await db?.end();
  });

  it("reads the copy only once, learns that it is a mirror, and reads every page", async () => {
    expect((await repo.getCrawl(db, crawlId))!.status).toBe("done");
    expect(hits.filter((h) => h.startsWith("localhost") && !h.endsWith("/robots.txt"))).toHaveLength(1);
    const events = await db.query("select data from crawl_events where crawl_id = $1 and type = 'scope.mirror'", [crawlId]);
    expect(events.rows[0]?.data).toMatchObject({ host: expect.stringMatching(/^localhost:/), same_as: expect.stringMatching(/^127\.0\.0\.1:/) });
    const pathsRead = new Set(hits.filter((h) => !h.endsWith("/robots.txt")).map((h) => h.replace(/^[^/]+/, "")));
    expect([...pathsRead].sort()).toEqual(["/", "/budget", "/finance", "/reports", "/staff"]);
  });

  it("holds a side host to its share of the budget, but not the main site", async () => {
    const seed = "http://main.example/";
    const { crawl } = await repo.createCrawl(
      db,
      { seedUrl: seed, keywords: DEFAULT_KEYWORDS, maxDepth: 3, pageBudget: 100, scopeDomain: "main.example", rankerVersion: RANKER_VERSION, idempotencyKey: null },
      { hash: urlHash(seed), host: "main.example" },
    );
    await repo.setCrawlStatus(db, crawl.id, "done"); // rows only: no runner works on it
    const rows = (host: string) =>
      Array.from({ length: 32 }, (_, i) => ({
        hash: urlHash(`http://${host}/p${i}`), url: `http://${host}/p${i}`, host, depth: 1, pathScore: 0.5, parent: seed, status: "queued" as const, reason: null,
      }));
    await repo.enqueue(db, crawl.id, [...rows("main.example"), ...rows("side.example")]);
    // 31 pages read on each host already, one left on each.
    await db.query("update frontier set status = 'done' where crawl_id = $1 and url not like '%/p31'", [crawl.id]);
    const uncapped = new Set(["main.example"]);
    const a = await repo.claimNext(db, crawl.id, false, 30, uncapped);
    const b = await repo.claimNext(db, crawl.id, false, 30, uncapped);
    const byHost = Object.fromEntries([a!, b!].map((x) => [x.host, !!x.capped]));
    expect(byHost).toEqual({ "main.example": false, "side.example": true });
  });

  it("never fetches the same page twice, and says why the copies were skipped", async () => {
    const pages = hits.filter((h) => !h.endsWith("/robots.txt")).map((h) => h.replace(/^[^/]+/, ""));
    expect(pages.length).toBe(new Set(pages).size);
    const r = await db.query("select reason from frontier where crawl_id = $1 and url like 'http://localhost%' and status = 'skipped'", [crawlId]);
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.every((x) => /^mirror of 127\.0\.0\.1:/.test(x.reason))).toBe(true);
  });
});
