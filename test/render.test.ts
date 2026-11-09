import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppContext, createContext, startCrawl } from "../src/app.js";
import type { Db } from "../src/db/client.js";
import { createLlm, memoryCache } from "../src/ranking/llm.js";
import { silentLog, testDb } from "./helpers/db.js";

/**
 * The render tier against a site drawn entirely by scripts. The browser is one already on the
 * machine (Edge on Windows, Chrome elsewhere, or BROWSER_EXECUTABLE); without one, these tests
 * are skipped.
 */
const BROWSER = {
  channel: process.env.BROWSER_EXECUTABLE ? undefined : process.env.BROWSER_CHANNEL ?? (process.platform === "win32" ? "msedge" : "chrome"),
  executablePath: process.env.BROWSER_EXECUTABLE,
};
const browserAvailable = await chromium
  .launch({ headless: true, ...BROWSER })
  .then(async (b) => (await b.close(), true))
  .catch(() => false);

const shell = (script: string, title = "Loading") =>
  `<!doctype html><html><head><title>${title}</title></head><body><div id="app"></div><script src="${script}"></script></body></html>`;

/** A school-district-like site whose pages are empty shells that scripts fill from JSON. */
function startScriptSite() {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    const path = req.url ?? "/";
    hits.push(path);
    const send = (type: string, body: string, status = 200) => {
      res.writeHead(status, { "content-type": type });
      res.end(body);
    };
    const routes: Record<string, () => void> = {
      "/robots.txt": () => send("text/plain", "User-agent: *\nDisallow: /private\n"),
      "/": () => send("text/html", shell("/home.js")),
      "/home.js": () =>
        send(
          "text/javascript",
          `fetch('/api/home').then(r => r.json()).then(d => {
             document.getElementById('app').innerHTML = d.html;
             return fetch('/private/data').then(r => r.text()).then(t => { document.getElementById('app').innerHTML += '<a href="/secret">' + t + '</a>'; });
           }).catch(() => {});`,
        ),
      "/api/home": () =>
        send(
          "application/json",
          JSON.stringify({
            html: `<h1>Welcome to the District</h1>
              <a href="/finance">Business &amp; Financial Services</a>
              <a href="/check">Board documents</a>
              <a href="/monitored">Financial reports</a>
              <a href="/refused">Transparency</a>
              <a href="/old-finance">Finance (old address)</a>
              <a href="/staff-portal">Staff portal</a>`,
          }),
        ),
      "/private/data": () => send("text/plain", "Secret budget"),
      "/finance": () => send("text/html", shell("/finance.js")),
      "/finance.js": () =>
        send("text/javascript", `fetch('/api/finance').then(r => r.json()).then(d => { document.getElementById('app').innerHTML = d.html; });`),
      "/api/finance": () =>
        send(
          "application/json",
          JSON.stringify({
            html: `<h1>Business &amp; Financial Services</h1>
              <h2>Adopted Budget</h2>
              <a href="/docs/fy2027-adopted-budget.pdf">FY2027 Adopted Budget</a>
              <div class="card"><p>Jane Roe</p><p>Chief Financial Officer</p><p><a href="mailto:jane.roe@example.gov">Email Ms. Roe</a></p></div>`,
          }),
        ),
      // A page that answers 200 but shows a bot check once its script runs.
      "/check": () => send("text/html", shell("/check.js")),
      "/check.js": () =>
        send("text/javascript", `document.title = 'Just a moment...'; document.getElementById('app').innerHTML = '<div class="cf-challenge">Checking your browser</div>';`),
      // A page that loads fully but carries a bot-protection script, as many sites do: not a check.
      "/monitored": () =>
        send(
          "text/html",
          `<!doctype html><html><head><title>Financial reports</title></head><body><div id="app"></div>
           <script src="/reports.js"></script><script src="/_Incapsula_Resource?SWJIYLWA=1"></script></body></html>`,
        ),
      "/reports.js": () =>
        send(
          "text/javascript",
          `document.getElementById('app').innerHTML = '<h1>Financial reports</h1><p>${"The district publishes its audited annual financial report every year after the audit is complete. ".repeat(14)}</p><a href="/docs/2025-annual-financial-report.pdf">Annual Financial Report FY2025</a>';`,
        ),
      "/_Incapsula_Resource": () => send("text/javascript", "/* monitoring */"),
      // An old address of the finance page, and a sign-in page that is an empty shell too.
      "/old-finance": () => {
        res.writeHead(302, { location: "/finance" });
        res.end();
      },
      // An ordinary link that redirects to single sign-on, as ASU's do.
      "/staff-portal": () => {
        res.writeHead(302, { location: "/account/login?next=/finance" });
        res.end();
      },
      "/account/login": () => send("text/html", shell("/login.js", "Sign in")),
      "/login.js": () => send("text/javascript", `document.getElementById('app').innerHTML = '<form><input name=user><input name=pass type=password></form>';`),
      // A page that refuses automated requests outright.
      "/refused": () => send("text/html", "<html><body>Forbidden</body></html>", 403),
    };
    const route = routes[path] ?? routes[path.split("?")[0]!];
    if (route) route();
    else send("text/html", "<html><body>not found</body></html>", 404);
  });
  return new Promise<{ url: string; hits: string[]; close: () => Promise<void> }>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        hits,
        close: () => new Promise((r) => server.close(() => r())),
      }),
    ),
  );
}

describe.skipIf(!browserAvailable)("render tier: pages drawn by scripts", () => {
  let db: Db;
  let site: Awaited<ReturnType<typeof startScriptSite>>;
  const contexts: AppContext[] = [];

  async function crawl(config: Record<string, unknown>, respectRobots = true) {
    site.hits.length = 0;
    const ctx = await createContext({
      db,
      log: silentLog,
      llm: createLlm({ model: "none", baseUrl: "http://unused", cache: memoryCache() }),
      config: { CRAWL_WORKERS: 2, MIN_HOST_DELAY_MS: 20, RAW_DIR: mkdtempSync(join(tmpdir(), "raw-")), BROWSER_CHANNEL: BROWSER.channel, BROWSER_EXECUTABLE: BROWSER.executablePath, ...config },
    });
    contexts.push(ctx);
    const { crawl } = await startCrawl(ctx, { url: `${site.url}/`, maxDepth: 3, pageBudget: 30, respectRobots });
    await ctx.runner.start(crawl.id);
    const events = (await db.query("select type, data from crawl_events where crawl_id = $1 order by id", [crawl.id])).rows as { type: string; data: Record<string, unknown> }[];
    return { id: crawl.id, events, hits: [...site.hits] };
  }

  beforeAll(async () => {
    db = await testDb();
    site = await startScriptSite();
  });

  afterAll(async () => {
    for (const c of contexts) await c.close();
    await site?.close();
    await db?.end();
  });

  describe("with RENDER_JS on", () => {
    let run: Awaited<ReturnType<typeof crawl>>;
    beforeAll(async () => {
      run = await crawl({ RENDER_JS: true });
    });

    it("opens the empty shells in the browser and finds the links, the budget and the contact the scripts draw", async () => {
      // By where the page ended up: /finance may be first reached through its old address.
      const rendered = await db.query("select coalesce(final_url, url) as url from pages where rendered order by 1");
      expect(rendered.rows.map((r) => r.url.replace(site.url, ""))).toEqual(expect.arrayContaining(["/", "/finance"]));
      const budget = await db.query(
        `select s.target_score, s.doc_type from link_scores s join links l on l.id = s.link_id where s.crawl_id = $1 and l.url like '%fy2027-adopted-budget.pdf'`,
        [run.id],
      );
      expect(budget.rows[0]).toMatchObject({ doc_type: "budget" });
      expect(budget.rows[0].target_score).toBeGreaterThanOrEqual(0.7);
      const contacts = await db.query("select name, title, email from contacts where crawl_id = $1", [run.id]);
      expect(contacts.rows).toEqual([{ name: "Jane Roe", title: "Chief Financial Officer", email: "jane.roe@example.gov" }]);
    });

    it("lets the browser load only what robots.txt allows", () => {
      expect(run.hits.some((h) => h.startsWith("/private"))).toBe(false);
      expect(run.hits).toContain("/api/home");
    });

    it("reports a bot check and does not use the page; never opens a page that refused us", async () => {
      const failed = run.events.filter((e) => e.type === "page.render_failed");
      expect(failed.map((e) => [String(e.data.url).replace(site.url, ""), e.data.reason])).toEqual([["/check", expect.stringMatching(/bot check/)]]);
      const check = await db.query("select rendered from pages where url = $1", [`${site.url}/check`]);
      expect(check.rows[0].rendered).toBe(false);
      const refusedInBrowser = run.events.some((e) => e.type.startsWith("page.render") && String(e.data.url).endsWith("/refused"));
      expect(refusedInBrowser).toBe(false);
      expect(run.hits.filter((h) => h === "/refused")).toHaveLength(2); // plain fetch and standard-agent fallback, no browser
    });

    it("opens each page in the browser once, however many links lead to it, and never a sign-in page", () => {
      const opened = run.events.filter((e) => e.type.startsWith("page.render")).map((e) => String(e.data.url).replace(site.url, ""));
      expect(opened.length).toBe(new Set(opened).size);
      expect(opened.filter((u) => u === "/finance")).toHaveLength(1);
      expect(run.hits).toContain("/account/login?next=/finance"); // reached by the plain fetch
      expect(opened.some((u) => u.includes("login"))).toBe(false); // but not opened in the browser
      expect(run.hits.some((h) => h.startsWith("/login.js"))).toBe(false); // so its script never ran
    });

    it("does not mistake a bot-protection script on a full page for a bot check", async () => {
      const monitored = await db.query("select rendered from pages where url = $1", [`${site.url}/monitored`]);
      expect(monitored.rows[0].rendered).toBe(true);
      const afr = await db.query(
        "select s.doc_type from link_scores s join links l on l.id = s.link_id where s.crawl_id = $1 and l.url like '%2025-annual-financial-report.pdf'",
        [run.id],
      );
      expect(afr.rows[0]?.doc_type).toBe("acfr");
    });
  });

  describe("with RENDER_JS off (the default)", () => {
    it("flags the shell as needing a browser and reads nothing from it", async () => {
      const run = await crawl({ RENDER_JS: false });
      expect(run.events.some((e) => e.type.startsWith("page.render"))).toBe(false);
      expect(run.hits.some((h) => h.startsWith("/api"))).toBe(false); // no scripts ran
      const home = await db.query("select needs_browser, rendered from pages where url = $1", [`${site.url}/`]);
      expect(home.rows[0]).toEqual({ needs_browser: true, rendered: false });
      const contacts = await db.query("select count(*)::int as n from contacts where crawl_id = $1", [run.id]);
      expect(contacts.rows[0].n).toBe(0);
    });
  });

  describe("render budget", () => {
    it("opens at most RENDER_MAX_PER_CRAWL pages in the browser", async () => {
      const run = await crawl({ RENDER_JS: true, RENDER_MAX_PER_CRAWL: 1 });
      expect(run.events.filter((e) => e.type === "page.rendered" || e.type === "page.render_failed")).toHaveLength(1);
    });
  });

  it("applies a crawl's robots opt-out to browser data requests", async () => {
    const run = await crawl({ RENDER_JS: true, RENDER_MAX_PER_CRAWL: 1 }, false);
    expect(run.hits).toContain("/private/data");
    expect(run.hits).not.toContain("/robots.txt");
  });
});
