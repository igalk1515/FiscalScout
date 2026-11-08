import { describe, expect, it } from "vitest";
import type { LinkCandidate } from "../src/crawler/extract.js";
import { compileKeywords, DEFAULT_KEYWORDS } from "../src/ranking/keywords.js";
import type { LlmClient } from "../src/ranking/llm.js";
import { scoreLink } from "../src/ranking/rules.js";
import { applyLlmTier } from "../src/ranking/tier.js";

const groups = compileKeywords(DEFAULT_KEYWORDS);
const NOW = new Date("2026-11-08T12:00:00Z");
const link = (url: string, anchor: string): LinkCandidate => ({
  url, anchor, titleAttr: "", heading: "Annual financials", context: "", boilerplate: false, nofollow: false, source: "html",
});

describe("LLM tier", () => {
  it("decides only unsure links, keeps year order, and records that the LLM decided", async () => {
    const xs = [
      link("https://x.edu/ASU-2026-Annual-comp-fin-rpt.pdf", "Annual comprehensive financial report 2026"),
      link("https://x.edu/ASU-2024-Annual-comp-fin-rpt.pdf", "Annual comprehensive financial report 2024"),
      link("https://x.edu/fy26-budget-book.pdf", "Adopted Budget FY2026"),
    ].map((l) => ({ link: l, s: scoreLink(l, { groups, parentPathScore: 0.9, internal: false, now: NOW }) }));
    const sent: number[] = [];
    const fake: LlmClient = {
      enabled: true,
      model: "fake",
      extractContacts: async () => [],
      classifyLinks: async (items) => {
        sent.push(items.length);
        return items.map((it) => ({ i: it.i, doc_type: "acfr", target_score: 1, path_score: 0, reason: "an ACFR" }));
      },
    };
    const decided = await applyLlmTier(fake, groups, xs, undefined, NOW);
    expect(decided).toBe(2); // the budget scored above 0.7 by rules and was not sent
    expect(sent).toEqual([2]);
    expect(xs[0]!.s.decidedBy).toBe("llm");
    expect(xs[0]!.s.targetScore).toBe(1);
    expect(xs[1]!.s.targetScore).toBeLessThan(xs[0]!.s.targetScore); // FY2024 keeps its discount
    expect(xs[2]!.s.decidedBy).toBeUndefined();
  });

  it("keeps a list page on the entity's site below the documents, even when the LLM is sure", async () => {
    const page = link("https://city.gov/finance/budgets", "Adopted Budgets");
    const xs = [{ link: page, s: scoreLink(page, { groups, parentPathScore: 0.9, internal: true, now: NOW }) }];
    xs[0]!.s.targetScore = 0.5; // make sure it is in the unsure band
    const fake: LlmClient = {
      enabled: true, model: "fake", extractContacts: async () => [],
      classifyLinks: async (items) => items.map((it) => ({ i: it.i, doc_type: "budget", target_score: 0.9, path_score: 0.9, reason: "budgets" })),
    };
    await applyLlmTier(fake, groups, xs, undefined, NOW);
    expect(xs[0]!.s.targetScore).toBeCloseTo(0.54);
    expect(xs[0]!.s.pathScore).toBeGreaterThanOrEqual(0.9); // still a page worth crawling
  });

  it("keeps a paper about the budget below the budget, even when the LLM is sure", async () => {
    const paper = link("https://cdn.gov/260501-fy27-budget-responses.pdf", "FY27 Budget Responses");
    const xs = [{ link: paper, s: scoreLink(paper, { groups, parentPathScore: 0.9, internal: false, now: NOW }) }];
    expect(xs[0]!.s.supportingPaper).toBe(true);
    const fake: LlmClient = {
      enabled: true, model: "fake", extractContacts: async () => [],
      classifyLinks: async (items) => items.map((it) => ({ i: it.i, doc_type: "budget", target_score: 0.9, path_score: 0, reason: "budget" })),
    };
    await applyLlmTier(fake, groups, xs, undefined, NOW);
    expect(xs[0]!.s.targetScore).toBeCloseTo(0.54);
  });

  it("keeps the rules scores when the call fails", async () => {
    const xs = [link("https://x.edu/a-2026-annual-comp-fin-rpt.pdf", "Annual comprehensive financial report 2026")].map((l) => ({
      link: l,
      s: scoreLink(l, { groups, parentPathScore: 0.9, internal: false, now: NOW }),
    }));
    const before = xs[0]!.s.targetScore;
    const down: LlmClient = { enabled: true, model: "fake", extractContacts: async () => null, classifyLinks: async () => null };
    await applyLlmTier(down, groups, xs, undefined, NOW);
    expect(xs[0]!.s.targetScore).toBe(before);
  });
});
