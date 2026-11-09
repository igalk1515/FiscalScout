import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
    "/forbidden": html("Access Denied", 403),
    "/auth": html("Sign in", 401),
    "/agent-sensitive": (req, res) => {
      html(req.headers["user-agent"] === UA ? "Access Denied" : "Public financial reports", req.headers["user-agent"] === UA ? 403 : 200)(req, res);
    },
    "/agent-redirect": (req, res) => {
      if (req.headers["user-agent"] === UA) return html("Access Denied", 403)(req, res);
      redirect("/agent-sensitive")(req, res);
    },
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

  it("recovers a User-Agent-specific 403 once and reuses the successful identity on that origin", async () => {
    const standardAgentOrigins = new Set<string>();
    const retry = vi.fn(async () => {});
    const before = site.hits.length;
    const options = { userAgent: UA, standardAgentOrigins, fallbackDelayMs: 0, onUserAgentFallback: retry };
    const first = await fetchUrl(`${site.url}/agent-sensitive`, options);
    expect(first).toMatchObject({ status: 200, userAgentFallback: true });
    expect(first.body?.toString()).toContain("Public financial reports");
    expect(standardAgentOrigins).toEqual(new Set([site.url]));
    expect((await fetchUrl(`${site.url}/agent-sensitive`, options)).status).toBe(200);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(site.hits.slice(before)).toHaveLength(3);
  });

  it("keeps a genuine 403 blocked after one fallback and does not remember a failed identity", async () => {
    const standardAgentOrigins = new Set<string>();
    const before = site.hits.length;
    const r = await fetchUrl(`${site.url}/forbidden`, { userAgent: UA, fallbackDelayMs: 0, standardAgentOrigins });
    expect(r.status).toBe(403);
    expect(isRetryable(r)).toBe(false);
    expect(site.hits.slice(before)).toEqual(["/forbidden", "/forbidden"]);
    expect(standardAgentOrigins.size).toBe(0);
  });

  it("does not change identity for authentication failures or rate limits", async () => {
    const retry = vi.fn(async () => {});
    const before = site.hits.length;
    for (const path of ["/auth", "/gone", "/busy"]) {
      await fetchUrl(`${site.url}${path}`, { userAgent: UA, onUserAgentFallback: retry });
    }
    expect(retry).not.toHaveBeenCalled();
    expect(site.hits.slice(before)).toEqual(["/auth", "/gone", "/busy"]);
  });

  it("checks policy before both new and remembered standard-agent requests", async () => {
    const before = site.hits.length;
    const beforeStandardAgentRequest = async () => "robots.txt (standard HTTP client)";
    const first = await fetchUrl(`${site.url}/agent-sensitive`, { userAgent: UA, fallbackDelayMs: 0, beforeStandardAgentRequest });
    expect(first.error).toBe("robots.txt (standard HTTP client)");
    const cached = await fetchUrl(`${site.url}/agent-sensitive`, { userAgent: UA, standardAgentOrigins: new Set([site.url]), beforeStandardAgentRequest });
    expect(cached.error).toBe(first.error);
    expect(site.hits.slice(before)).toHaveLength(1);
  });

  it("keeps the redirect budget and redirect checks across a fallback", async () => {
    const beforeRedirect = vi.fn(async () => null);
    const r = await fetchUrl(`${site.url}/agent-redirect`, { userAgent: UA, maxRedirects: 1, fallbackDelayMs: 0, beforeRedirect });
    expect(r.status).toBe(200);
    expect(r.redirects).toEqual([`${site.url}/agent-sensitive`]);
    expect(beforeRedirect).toHaveBeenCalledTimes(1);
    const stopped = await fetchUrl(`${site.url}/agent-redirect`, { userAgent: UA, maxRedirects: 0, fallbackDelayMs: 0 });
    expect(stopped.error).toBe("too many redirects");
  });

  it("includes the fallback delay in the overall timeout", async () => {
    const before = site.hits.length;
    const r = await fetchUrl(`${site.url}/agent-sensitive`, { userAgent: UA, timeoutMs: 100, fallbackDelayMs: 1000 });
    expect(r.error).toBe("timeout");
    expect(site.hits.slice(before)).toHaveLength(1);
  });
});
