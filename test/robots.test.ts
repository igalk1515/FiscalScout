import { describe, expect, it } from "vitest";
import { crawlDelayMs, isAllowed, policyFromResponse } from "../src/crawler/robots.js";

const ROBOTS = "https://example.com/robots.txt";
const rules = (text: string) => policyFromResponse(ROBOTS, 200, text);

describe("robots.txt rules (RFC 9309)", () => {
  // The example from RFC 9309, section 5.1
  const rfc = rules(`User-Agent: *
Disallow: *.gif$
Disallow: /example/
Allow: /publications/

User-Agent: foobot
Disallow:/
Allow:/example/page.html
Allow:/example/allowed.gif
`);

  it("applies the group for a named bot", () => {
    expect(isAllowed(rfc, "https://example.com/example/page.html", "foobot")).toBe(true);
    expect(isAllowed(rfc, "https://example.com/example/allowed.gif", "foobot")).toBe(true);
    expect(isAllowed(rfc, "https://example.com/other", "foobot")).toBe(false);
  });

  it("falls back to the * group for everyone else", () => {
    expect(isAllowed(rfc, "https://example.com/example/x", "HighValueLinkScraper")).toBe(false);
    expect(isAllowed(rfc, "https://example.com/image.gif", "HighValueLinkScraper")).toBe(false);
    expect(isAllowed(rfc, "https://example.com/publications/a", "HighValueLinkScraper")).toBe(true);
    expect(isAllowed(rfc, "https://example.com/finance", "HighValueLinkScraper")).toBe(true);
  });

  it("uses the longest match, and allow wins a tie", () => {
    const p = rules("User-agent: *\nDisallow: /finance\nAllow: /finance/reports\nAllow: /page\nDisallow: /page");
    expect(isAllowed(p, "https://example.com/finance/budget", "bot")).toBe(false);
    expect(isAllowed(p, "https://example.com/finance/reports/acfr.pdf", "bot")).toBe(true);
    expect(isAllowed(p, "https://example.com/page", "bot")).toBe(true);
  });

  it("supports * and $ in paths", () => {
    const p = rules("User-agent: *\nDisallow: /*.pdf$");
    expect(isAllowed(p, "https://example.com/a/budget.pdf", "bot")).toBe(false);
    expect(isAllowed(p, "https://example.com/a/budget.pdf?download=1", "bot")).toBe(true);
  });

  it("matches the user-agent token case-insensitively", () => {
    const p = rules("User-agent: highvaluelinkscraper\nDisallow: /\n\nUser-agent: *\nAllow: /");
    expect(isAllowed(p, "https://example.com/x", "HighValueLinkScraper")).toBe(false);
    expect(isAllowed(p, "https://example.com/x", "OtherBot")).toBe(true);
  });

  it("reads Crawl-delay", () => {
    const p = rules("User-agent: *\nCrawl-delay: 5\nDisallow: /private");
    expect(crawlDelayMs(p, "bot")).toBe(5000);
  });
});

describe("robots.txt status codes (RFC 9309, section 2.3.1)", () => {
  it("4xx means no rules: everything is allowed", () => {
    expect(isAllowed(policyFromResponse(ROBOTS, 404, null), "https://example.com/x", "bot")).toBe(true);
    expect(isAllowed(policyFromResponse(ROBOTS, 403, null), "https://example.com/x", "bot")).toBe(true);
  });
  it("5xx or no answer means everything is disallowed", () => {
    expect(isAllowed(policyFromResponse(ROBOTS, 503, null), "https://example.com/x", "bot")).toBe(false);
    expect(isAllowed(policyFromResponse(ROBOTS, 0, null), "https://example.com/x", "bot")).toBe(false);
  });
});
