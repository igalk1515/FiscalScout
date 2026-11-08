import { describe, expect, it } from "vitest";
import {
  fileTypeFromUrl,
  inScope,
  isEntityNamedHost,
  normalizeUrl,
  registrableDomain,
  trapReason,
} from "../src/crawler/url.js";

describe("normalizeUrl", () => {
  it("lowercases the host, drops the fragment and the default port", () => {
    expect(normalizeUrl("HTTPS://WWW.A2GOV.ORG:443/Finance/#top")).toBe("https://www.a2gov.org/Finance/");
  });
  it("removes tracking and session parameters and sorts the rest", () => {
    expect(normalizeUrl("https://x.gov/p?utm_source=mail&b=2&fbclid=z&a=1&sid=9")).toBe("https://x.gov/p?a=1&b=2");
  });
  it("strips ;jsessionid from the path", () => {
    expect(normalizeUrl("https://x.gov/a;jsessionid=ABC123/b")).toBe("https://x.gov/a/b");
  });
  it("resolves relative links against the page", () => {
    expect(normalizeUrl("../budget.pdf", "https://x.gov/finance/reports/")).toBe("https://x.gov/finance/budget.pdf");
  });
  it("rejects anything that is not http(s)", () => {
    expect(normalizeUrl("mailto:a@b.gov")).toBeNull();
    expect(normalizeUrl("javascript:void(0)")).toBeNull();
    expect(normalizeUrl("tel:+15550100")).toBeNull();
  });
  it("gives the same string for two spellings of one page", () => {
    expect(normalizeUrl("https://x.gov/p?b=2&a=1#x")).toBe(normalizeUrl("https://X.gov/p?a=1&b=2"));
  });
});

describe("scope", () => {
  it("uses the registrable domain, so subdomains are in scope", () => {
    expect(registrableDomain("cfo.asu.edu")).toBe("asu.edu");
    const scope = { domain: "asu.edu", extraHosts: new Set<string>() };
    expect(inScope("https://cfo.asu.edu/financial-reports", scope)).toBe(true);
    expect(inScope("https://www.facebook.com/asu", scope)).toBe(false);
  });
  it("accepts hosts that joined the scope", () => {
    const scope = { domain: "boerneisd.net", extraHosts: new Set(["boerneisd.smartsiteshost.com"]) };
    expect(inScope("https://boerneisd.smartsiteshost.com/82152_3", scope)).toBe(true);
  });
  it("recognizes the entity's own site on a vendor platform", () => {
    expect(isEntityNamedHost("boerneisd.smartsiteshost.com", "boerneisd.net")).toBe(true);
    expect(isEntityNamedHost("files.smartsites.parentsquare.com", "boerneisd.net")).toBe(false);
    expect(isEntityNamedHost("asu.example.com", "asu.edu")).toBe(false); // label too short to trust
  });
  it("falls back to the host for local test servers", () => {
    expect(registrableDomain("127.0.0.1")).toBe("127.0.0.1");
  });
});

describe("fileTypeFromUrl", () => {
  it("reads document extensions and ignores media", () => {
    expect(fileTypeFromUrl("https://x.gov/a/FY26-Budget.PDF")).toBe("pdf");
    expect(fileTypeFromUrl("https://x.gov/budget.xlsx")).toBe("xlsx");
    expect(fileTypeFromUrl("https://x.gov/logo.png")).toBe("media");
    expect(fileTypeFromUrl("https://x.gov/DocumentCenter/View/2087")).toBeNull();
  });
});

describe("trapReason", () => {
  const now = new Date("2026-11-08T00:00:00Z");
  it("catches endless calendars", () => {
    expect(trapReason("https://x.gov/calendar?month=2031-04", now)).toMatch(/calendar/);
    expect(trapReason("https://x.gov/events/2031/04", now)).toMatch(/calendar/);
    expect(trapReason("https://x.gov/calendar?month=2026-12", now)).toBeNull();
  });
  it("catches repeating paths and parameter explosions", () => {
    expect(trapReason("https://x.gov/a/b/a/b/a/b", now)).toBe("repeating path");
    expect(trapReason("https://x.gov/p?a=1&b=2&c=3&d=4&e=5&f=6", now)).toBe("too many parameters");
  });
  it("lets normal pages through, including old reports", () => {
    expect(trapReason("https://x.gov/finance/reports/2019-annual-report", now)).toBeNull();
  });
});
