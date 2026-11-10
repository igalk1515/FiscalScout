import { describe, expect, it } from "vitest";
import type { LinkCandidate } from "../src/crawler/extract.js";
import { compileKeywords, DEFAULT_KEYWORDS } from "../src/ranking/keywords.js";
import { FEATURES, type FeatureName, groupFeatures, type LearnedModel, scoreLinkLearned } from "../src/ranking/learned.js";
import { LEARNED_MODEL } from "../src/ranking/learned-weights.js";
import { auc, predict, trainLogistic } from "../src/ranking/logistic.js";
import { rankerName, rankerVersion, rankLink } from "../src/ranking/rank.js";
import { scoreLink } from "../src/ranking/rules.js";

const NOW = new Date("2026-11-09T12:00:00Z");
const groups = compileKeywords(DEFAULT_KEYWORDS);

const link = (url: string, anchor: string, extra: Partial<LinkCandidate> = {}): LinkCandidate => ({
  url,
  anchor,
  titleAttr: "",
  heading: "",
  context: "",
  boilerplate: false,
  nofollow: false,
  source: "html",
  ...extra,
});
const ctx = (internal = true, parentPathScore = 0.8) => ({ groups, parentPathScore, internal, now: NOW });

/** A small hand-made model, so these tests don't depend on the trained weights. */
function model(w: Partial<Record<FeatureName, number>>, bias = -3): LearnedModel {
  const weights = Object.fromEntries(FEATURES.map((f) => [f, w[f] ?? 0])) as Record<FeatureName, number>;
  return { version: "learned-test", bias, weights, trainedAt: "", trainedOn: { sites: 0, links: 0, positives: 0, labeler: "" } };
}
const toy = model({ anchor_term: 3, anchor_full_name: 4, url_term: 1, document_file: 2, supporting_paper: -4, own_site_page_for_document: -2 });

describe("logistic regression", () => {
  it("learns the sign and order of the weights", () => {
    // y depends strongly on x0, weakly on x1, and not on x2.
    const X: number[][] = [];
    const y: number[] = [];
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 2000; i++) {
      const x = [rand() < 0.5 ? 1 : 0, rand() < 0.5 ? 1 : 0, rand() < 0.5 ? 1 : 0];
      const p = 1 / (1 + Math.exp(-(-1 + 3 * x[0]! + 1 * x[1]!)));
      X.push(x);
      y.push(rand() < p ? 1 : 0);
    }
    const m = trainLogistic(X, y, { l2: 0.1 });
    expect(m.weights[0]).toBeGreaterThan(2);
    expect(m.weights[1]).toBeGreaterThan(0.4);
    expect(Math.abs(m.weights[2]!)).toBeLessThan(0.4);
    expect(predict(m, [1, 1, 0])).toBeGreaterThan(predict(m, [0, 0, 0]));
  });

  it("measures AUC, with ties counting half", () => {
    expect(auc([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0])).toBe(1);
    expect(auc([0.1, 0.2, 0.8, 0.9], [1, 1, 0, 0])).toBe(0);
    expect(auc([0.5, 0.5], [1, 0])).toBe(0.5);
  });
});

describe("features", () => {
  it("reads where the keyword sits and what kind of link it is", () => {
    const l = link("https://city.gov/files/fy2026-adopted-budget.pdf", "Adopted Budget FY2026", { heading: "Annual Budgets" });
    const base = scoreLink(l, ctx());
    const budget = groups.find((g) => g.key === "budget")!;
    const f = groupFeatures(l, ctx(), budget, base)!;
    expect(f.values.anchor_term).toBe(1);
    expect(f.values.url_term).toBe(1);
    expect(f.values.heading_term).toBe(1);
    expect(f.values.document_file).toBe(1);
    expect(f.values.has_year).toBe(1);
    expect(f.values.contact_group).toBe(0);
  });

  it("scales keyword features by the group's weight", () => {
    const l = link("https://city.gov/files/single-audit-2025.pdf", "Single Audit 2025");
    const audit = groups.find((g) => g.key === "single audit")!;
    const f = groupFeatures(l, ctx(), audit, scoreLink(l, ctx()))!;
    expect(f.values.anchor_term).toBeCloseTo(audit.weight);
  });

  it("has no features for a group whose terms do not appear", () => {
    const l = link("https://city.gov/parks/", "Parks and Recreation");
    expect(groups.every((g) => groupFeatures(l, ctx(), g, scoreLink(l, ctx())) === null)).toBe(true);
  });
});

describe("learned scoring", () => {
  it("scores a budget PDF above a paper about the budget and above the page that lists budgets", () => {
    const book = scoreLinkLearned(link("https://city.gov/files/fy2026-budget-book.pdf", "FY2026 Budget Book"), ctx(), toy);
    const notice = scoreLinkLearned(link("https://city.gov/files/fy2026-budget-hearing-notice.pdf", "Budget Hearing Notice FY2026"), ctx(), toy);
    const hub = scoreLinkLearned(link("https://city.gov/finance/budget/", "Budget"), ctx(), toy);
    expect(book.targetScore).toBeGreaterThan(0.5);
    expect(book.targetScore).toBeGreaterThan(notice.targetScore);
    expect(book.targetScore).toBeGreaterThan(hub.targetScore);
    expect(book.decidedBy).toBe("learned");
    expect(book.docType).toBe("budget");
    expect(book.reason).toContain("'budget' in the link text");
  });

  it("keeps the hand-set policy: an older year ranks lower than the same document this year", () => {
    const now = scoreLinkLearned(link("https://city.gov/files/acfr-2025.pdf", "ACFR 2025"), ctx(), toy);
    const old = scoreLinkLearned(link("https://city.gov/files/acfr-2019.pdf", "ACFR 2019"), ctx(), toy);
    expect(old.targetScore).toBeLessThan(now.targetScore);
    expect(old.reason).toContain("fiscal year 2019");
  });

  it("leaves noise and links without a keyword at zero", () => {
    expect(scoreLinkLearned(link("https://facebook.com/citybudget", "Budget on Facebook"), ctx(false), toy).targetScore).toBe(0);
    expect(scoreLinkLearned(link("https://city.gov/parks/", "Parks"), ctx(), toy).targetScore).toBe(0);
  });

  it("routes a crawl to its ranker by the stored version", () => {
    const l = link("https://city.gov/files/fy2026-budget-book.pdf", "FY2026 Budget Book");
    expect(rankerName(rankerVersion("learned"))).toBe("learned");
    expect(rankerName(rankerVersion("rules"))).toBe("rules");
    expect(rankLink(l, ctx(), rankerVersion("rules")).decidedBy).toBeUndefined();
    expect(rankLink(l, ctx(), rankerVersion("learned")).decidedBy).toBe("learned");
  });
});

describe("the trained weights", () => {
  const trained = LEARNED_MODEL.trainedOn.links > 0;
  it.runIf(trained)("rank the budget itself above the page that lists budgets", () => {
    const book = scoreLinkLearned(link("https://city.gov/files/fy2026-adopted-budget.pdf", "FY2026 Adopted Budget"), ctx(), LEARNED_MODEL);
    const hub = scoreLinkLearned(link("https://city.gov/finance/budget/", "Budget"), ctx(), LEARNED_MODEL);
    expect(book.targetScore).toBeGreaterThan(hub.targetScore);
  });
  it.runIf(trained)("rank an annual financial report above a presentation about it", () => {
    const acfr = scoreLinkLearned(link("https://city.gov/files/acfr-2025.pdf", "Annual Comprehensive Financial Report 2025"), ctx(), LEARNED_MODEL);
    const deck = scoreLinkLearned(link("https://city.gov/files/acfr-2025-presentation.pdf", "ACFR 2025 Presentation"), ctx(), LEARNED_MODEL);
    expect(acfr.targetScore).toBeGreaterThan(deck.targetScore);
  });
});
