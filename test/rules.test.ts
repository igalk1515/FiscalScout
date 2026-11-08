import { describe, expect, it } from "vitest";
import { extractPage } from "../src/crawler/extract.js";
import { inScope, registrableDomain } from "../src/crawler/url.js";
import { currentFiscalYear, fiscalYearIn, isDraft, isYearOnlyAnchor, recencyMultiplier } from "../src/ranking/fileinfo.js";
import { compileKeywords, DEFAULT_KEYWORDS, matchText, matchUrlPart } from "../src/ranking/keywords.js";
import { scoreLink } from "../src/ranking/rules.js";
import { fixture, type FixtureName } from "./helpers/fixtures.js";

const NOW = new Date("2026-11-08T12:00:00Z");
const groups = compileKeywords(DEFAULT_KEYWORDS);

function scored(name: FixtureName, parentPathScore = 0.9, g = groups) {
  const { html, url } = fixture(name);
  const page = extractPage(html, url);
  const scope = { domain: registrableDomain(new URL(url).hostname), extraHosts: new Set<string>() };
  return page.links.map((link) => ({
    link,
    s: scoreLink(link, { groups: g, parentPathScore, internal: inScope(link.url, scope), now: NOW }),
  }));
}
const byTarget = <T extends { s: { targetScore: number } }>(xs: T[]) => [...xs].sort((a, b) => b.s.targetScore - a.s.targetScore);

describe("keyword matching", () => {
  const acfr = groups.find((g) => g.key === "acfr")!;
  const fin = groups.find((g) => g.key === "finance director")!;
  it("matches whole words and plurals in text", () => {
    expect(matchText(acfr, "Annual Comprehensive Financial Report (ACFR)")).toBeTruthy();
    expect(matchText(groups.find((g) => g.key === "single audit")!, "Single Audits")).toBe("single audit");
    expect(matchText(fin, "Treasurer's Office")).toBe("treasurer");
    expect(matchText(fin, "dicfoot")).toBeNull();
  });
  it("finds long terms inside run-together file names, short ones only as words", () => {
    expect(matchUrlPart(acfr, "/13370/2025acfrfinal.pdf")).toBe("acfr");
    expect(matchUrlPart(fin, "cfo")).toBe("cfo");
    expect(matchUrlPart(fin, "/scfold/x")).toBeNull();
  });
});

describe("fiscal year and draft helpers", () => {
  it("reads the strongest year pattern", () => {
    expect(fiscalYearIn(".pdf 2026-07-26 Annual Financial Report: June 30, 2025")).toBe(2025);
    expect(fiscalYearIn("city-of-ann-arbor-6-30-25-acfr-final")).toBe(2025);
    expect(fiscalYearIn("FY 2027")).toBe(2027);
    expect(fiscalYearIn("fy26-budget-book")).toBe(2026);
    expect(fiscalYearIn("2026-27 Adopted Budget")).toBe(2027);
    expect(fiscalYearIn("2025acfrfinal")).toBe(2025);
    expect(fiscalYearIn("no year here")).toBeNull();
  });
  it("knows the fiscal year in progress and discounts old years", () => {
    expect(currentFiscalYear(NOW)).toBe(2027);
    expect(recencyMultiplier(2026, NOW)).toBe(1);
    expect(recencyMultiplier(2024, NOW)).toBeCloseTo(0.84);
    expect(recencyMultiplier(2001, NOW)).toBe(0.6);
  });
  it("spots drafts and year-only anchors", () => {
    expect(isDraft(["acfr-2023_11-09-23_draft.pdf"])).toBe(true);
    expect(isDraft(["final report"])).toBe(false);
    expect(isYearOnlyAnchor("Fiscal Year 2025")).toBe(true);
    expect(isYearOnlyAnchor("FY 2027")).toBe(true);
    expect(isYearOnlyAnchor("2026-27 Adopted Budget")).toBe(false);
  });
});

describe("rules scoring on the test sites", () => {
  it("Ann Arbor: ACFR and budget links score at least 0.7, 'Poverty Exemptions' scores low", () => {
    const xs = scored("a2gov_reports");
    const acfr = xs.find((x) => x.link.url.endsWith("6-30-25-acfr-final.pdf"))!;
    expect(acfr.s.targetScore).toBeGreaterThanOrEqual(0.7);
    expect(acfr.s.docType).toBe("acfr");
    expect(acfr.s.fiscalYear).toBe(2025);
    const budget = xs.find((x) => x.link.url.endsWith("fy26-budget-book.pdf"))!;
    expect(budget.s.targetScore).toBeGreaterThanOrEqual(0.7);
    expect(budget.s.docType).toBe("budget");
    const fin = scored("a2gov_finance");
    const poverty = fin.find((x) => /poverty/i.test(x.link.anchor));
    expect(poverty).toBeDefined();
    expect(poverty!.s.targetScore).toBeLessThan(0.2);
  });

  it("Ann Arbor: the newest year ranks first among ACFRs", () => {
    const acfrs = byTarget(scored("a2gov_reports").filter((x) => x.s.docType === "acfr"));
    expect(acfrs[0]!.link.url).toMatch(/6-30-25-acfr-final/);
  });

  it("Boerne: the final FY2025 report ranks first, and the FY2023 draft is marked and lowered", () => {
    const xs = byTarget(scored("boerne_afr").filter((x) => x.s.docType === "acfr"));
    expect(xs[0]!.link.url).toMatch(/2025acfrfinal\.pdf$/);
    expect(xs[0]!.s.targetScore).toBeGreaterThanOrEqual(0.7);
    const draft = xs.find((x) => /draft/.test(x.link.url))!;
    expect(draft.s.isDraft).toBe(true);
    expect(draft.s.reason).toMatch(/draft/);
  });

  it("Boerne: the 2026-27 budget is FY2027 and the spreadsheet counts as a document", () => {
    const xs = scored("boerne_budgets");
    const pdf = xs.find((x) => x.link.url.endsWith("2026-2027_bisd_adopted_budget.pdf"))!;
    expect(pdf.s.fiscalYear).toBe(2027);
    expect(pdf.s.targetScore).toBeGreaterThanOrEqual(0.7);
    const xlsx = xs.find((x) => x.link.url.endsWith(".xlsx"));
    expect(xlsx?.s.type).toBe("document");
  });

  it("ASU home: the footer 'Jobs' link to cfo.asu.edu has the best path score, from the host name", () => {
    const xs = scored("asu_home", 1).sort((a, b) => b.s.pathScore - a.s.pathScore);
    expect(xs[0]!.link.url).toBe("https://cfo.asu.edu/applicant");
    expect(xs[0]!.s.reason).toMatch(/host name/);
  });

  it("ASU: the newest ACFR ranks first, and the SharePoint FY 2027 budget is found from its heading", () => {
    const acfrs = byTarget(scored("asu_reports").filter((x) => x.s.docType === "acfr"));
    expect(acfrs[0]!.link.url).toMatch(/ASU-2026-Annual-comp-fin-rpt\.pdf$/);
    const budgets = byTarget(scored("asu_budget").filter((x) => x.s.docType === "budget"));
    expect(budgets[0]!.link.anchor).toBe("FY 2027");
    expect(budgets[0]!.s.fileType).toBe("pdf");
  });

  it("documents are never queued for crawling, noise gets no target score", () => {
    const xs = scored("a2gov_home");
    for (const x of xs.filter((x) => x.s.type === "document")) expect(x.s.pathScore).toBe(0);
    const social = xs.find((x) => /facebook\.com/.test(x.link.url));
    if (social) expect(social.s.targetScore).toBe(0);
  });

  it("keywords are per crawl: with other keywords the ACFR is no longer a result", () => {
    const police = compileKeywords({ "body cameras": { weight: 1, kind: "document", synonyms: ["body-worn camera"] } });
    const acfr = scored("a2gov_reports", 0.9, police).find((x) => x.link.url.endsWith("6-30-25-acfr-final.pdf"))!;
    expect(acfr.s.targetScore).toBe(0);
  });
});
