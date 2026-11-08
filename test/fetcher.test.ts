import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchUrl, isRetryable } from "../src/crawler/fetcher.js";
import { html, redirect, startServer, text } from "./helpers/server.js";

let site: Awaited<ReturnType<typeof startServer>>;
const UA = "HighValueLinkScraper/0.1 (+https://example.com/bot)";
let seenUa = "";

beforeAll(async () => {
  site = await startServer({
    "/page": (req, res) => {
      seenUa = String(req.headers["user-agent"]);
      html("<a href='/x'>x</a>")(req, res);
    },
    "/r1": redirect("/r2"),
    "/r2": redirect("/page", 302),
    "/loop-a": redirect("/loop-b"),
    "/loop-b": redirect("/loop-a"),
    "/far": redirect("https://elsewhere.example.org/page"),
    "/doc.pdf": text("%PDF-1.4 fake", 200, "application/pdf"),
    "/big": html("x".repeat(200_000)),
    "/gone": html("gone", 404),
    "/busy": (_req, res) => {
      res.writeHead(503, { "retry-after": "7", "content-type": "text/html" });
      res.end("busy");
    },
    "/slow": (_req, res) => {
      setTimeout(() => html("late")(_req, res), 2_000);
    },
  });
});
afterAll(() => site.close());

describe("fetchUrl", () => {
  it("sends the honest User-Agent and reads HTML", async () => {
    const r = await fetchUrl(`${site.url}/page`, { userAgent: UA });
    expect(r.status).toBe(200);
    expect(r.isHtml).toBe(true);
    expect(r.body?.toString()).toContain("href='/x'");
    expect(seenUa).toBe(UA);
  });

  it("follows redirects and records the final URL", async () => {
    const r = await fetchUrl(`${site.url}/r1`, { userAgent: UA });
    expect(r.status).toBe(200);
    expect(r.finalUrl).toBe(`${site.url}/page`);
    expect(r.redirects).toHaveLength(2);
  });

  it("stops a redirect loop", async () => {
    const r = await fetchUrl(`${site.url}/loop-a`, { userAgent: UA });
    expect(r.error).toBe("redirect loop");
  });

  it("asks before following a redirect, and stops when told to", async () => {
    const r = await fetchUrl(`${site.url}/far`, {
      userAgent: UA,
      beforeRedirect: async (_from, to) => (to.includes("elsewhere") ? "out of scope" : null),
    });
    expect(r.error).toBe("out of scope");
    expect(r.finalUrl).toBe("https://elsewhere.example.org/page");
  });

  it("does not download non-HTML bodies", async () => {
    const r = await fetchUrl(`${site.url}/doc.pdf`, { userAgent: UA });
    expect(r.status).toBe(200);
    expect(r.contentType).toBe("application/pdf");
    expect(r.body).toBeNull();
  });

  it("caps the size", async () => {
    const r = await fetchUrl(`${site.url}/big`, { userAgent: UA, maxBytes: 50_000 });
    expect(r.truncated).toBe(true);
  });

  it("times out", async () => {
    const r = await fetchUrl(`${site.url}/slow`, { userAgent: UA, timeoutMs: 300 });
    expect(r.error).toBe("timeout");
    expect(isRetryable(r)).toBe(true);
  });

  it("treats 4xx as final and 5xx as retryable, and reads Retry-After", async () => {
    const gone = await fetchUrl(`${site.url}/gone`, { userAgent: UA });
    expect(gone.status).toBe(404);
    expect(isRetryable(gone)).toBe(false);
    const busy = await fetchUrl(`${site.url}/busy`, { userAgent: UA });
    expect(busy.status).toBe(503);
    expect(isRetryable(busy)).toBe(true);
    expect(busy.retryAfterMs).toBe(7000);
  });
});
