import { describe, expect, it } from "vitest";
import { blockText, cleanText, extractPage, parseHtml } from "../src/crawler/extract.js";
import { fixture } from "./helpers/fixtures.js";

describe("extractPage on saved pages from the test sites", () => {
  it("Ann Arbor: 'Fiscal Year 2025' comes out with the ACFR heading above it", () => {
    const { html, url } = fixture("a2gov_reports");
    const page = extractPage(html, url);
    const acfr = page.links.find((l) => l.url.endsWith("city-of-ann-arbor-6-30-25-acfr-final.pdf"));
    expect(acfr).toBeDefined();
    expect(acfr!.anchor).toBe("Fiscal Year 2025");
    // The heading on the site hides a zero-width space inside "Annual"; it must be gone.
    expect(acfr!.heading).toBe("Annual Comprehensive Financial Report (ACFR)");
    expect(acfr!.titleAttr).toContain("ACFR");
    expect(acfr!.boilerplate).toBe(false);
  });

  it("Ann Arbor: menu links are marked as boilerplate", () => {
    const { html, url } = fixture("a2gov_home");
    const page = extractPage(html, url);
    expect(page.links.length).toBeGreaterThan(50);
    expect(page.links.some((l) => l.boilerplate)).toBe(true);
    expect(page.thin).toBe(false);
  });

  it("ASU home: the menu is not in the HTML, but the footer 'Jobs' link to cfo.asu.edu is", () => {
    const { html, url } = fixture("asu_home");
    const page = extractPage(html, url);
    const jobs = page.links.find((l) => l.url === "https://cfo.asu.edu/applicant");
    expect(jobs?.anchor).toBe("Jobs");
    expect(jobs?.boilerplate).toBe(true);
  });

  it("ASU CFO site: reads the leadership card that a script would draw", () => {
    const { html, url } = fixture("asu_cfo");
    const page = extractPage(html, url);
    expect(page.dataBlocks.some((b) => b.includes("Morgan R. Olsen") && b.includes("CFO"))).toBe(true);
    expect(page.links.some((l) => l.url === "https://cfo.asu.edu/financial-reports")).toBe(true);
  });

  it("ClearGov viewer: the HTML is an empty app shell, so it needs a browser", () => {
    const { html, url } = fixture("cleargov");
    const page = extractPage(html, url);
    expect(page.thin).toBe(true);
    expect(page.visibleTextLength).toBeLessThan(300);
  });

  it("Boerne: the annual financial report links point to the file host", () => {
    const { html, url } = fixture("boerne_afr");
    const page = extractPage(html, url);
    const afr = page.links.find((l) => l.url.endsWith("/13370/2025acfrfinal.pdf"));
    expect(afr).toBeDefined();
    expect(afr!.anchor + " " + afr!.context).toMatch(/Annual Financial Report/i);
  });
});

describe("text helpers", () => {
  it("cleanText removes zero-width and non-breaking spaces", () => {
    expect(cleanText("Ann​ual  Report ")).toBe("Annual Report");
  });
  it("blockText keeps line breaks at <br> and blocks", () => {
    const $ = parseHtml("<div><p>Marti Praschan,<br> Chief Financial Officer</p><div>734.794.6500</div></div>");
    expect(blockText($("div").get(0)!)).toBe("Marti Praschan,\nChief Financial Officer\n734.794.6500");
  });
  it("reads meta robots and canonical", () => {
    const page = extractPage(
      '<html><head><meta name="robots" content="noindex, nofollow"><link rel="canonical" href="/a?b=1#x"></head><body></body></html>',
      "https://x.gov/a",
    );
    expect(page.metaNofollow).toBe(true);
    expect(page.metaNoindex).toBe(true);
    expect(page.canonical).toBe("https://x.gov/a?b=1");
  });
});
