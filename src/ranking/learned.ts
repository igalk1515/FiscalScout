import type { LinkCandidate } from "../crawler/extract.js";
import { isYearOnlyAnchor, recencyMultiplier } from "./fileinfo.js";
import type { CompiledGroup } from "./keywords.js";
import { urlWords } from "./keywords.js";
import { type LogisticModel, logit, sigmoid } from "./logistic.js";
import { groupMatches, type LinkScore, onOtherGovernmentSite, type ScoreContext, scoreLink, SUPPORTING_PAPER } from "./rules.js";

/**
 * The learned ranker. It reads the same evidence as the rules (where a keyword sits, what kind of
 * link it is, where it was found), but the weight of each piece of evidence was fitted by
 * logistic regression on labeled links instead of set by hand. The output is the chance that
 * the link itself is a target. Ranking policy that is not about relevance stays explicit and
 * hand-set, exactly as in the LLM tier: older fiscal years and drafts rank lower.
 */
export const LEARNED_RANKER = "learned-1";

/** Every feature, in the order of the weight vector. Keyword features scale with the group's weight. */
export const FEATURES = [
  "anchor_full_name",
  "anchor_term",
  "anchor_clean_name",
  "anchor_extra_words",
  "url_term",
  "heading_term",
  "context_term",
  "only_nearby_text",
  "year_only_anchor",
  "host_term",
  "contact_group",
  "document_file",
  "file_for_contact",
  "own_site_page_for_document",
  "other_platform_page_for_document",
  "parent_path_score",
  "in_menu",
  "supporting_paper",
  "other_government_site",
  "has_year",
  "no_link_text",
  "long_link_text",
] as const;
export type FeatureName = (typeof FEATURES)[number];

export interface LearnedModel {
  version: string;
  bias: number;
  weights: Record<FeatureName, number>;
  trainedAt: string;
  trainedOn: { sites: number; links: number; positives: number; labeler: string };
}

export interface GroupFeatures {
  group: CompiledGroup;
  values: Record<FeatureName, number>;
  /** Human-readable name of each non-zero feature, for the explanation. */
  labels: Partial<Record<FeatureName, string>>;
}

const bool = (b: unknown) => (b ? 1 : 0);

/** Words that say nothing about what a document is: years, file types, the kind of public body. */
const FILLER = new Set(
  ("the of for and a an to in on at by fy fiscal year years pdf final file download view document link kb mb " +
    "city county town village district school schools isd unified public university college state annual")
    .split(" "),
);

/**
 * How many words the link text has besides the group's terms, years and filler. "Adopted Budget
 * FY2026" has none: it is the document's name. "FY2015 Budget Impact Analysis" has two: it is a
 * paper about the budget.
 */
export function extraAnchorWords(anchor: string, group: CompiledGroup): number {
  let a = ` ${anchor.toLowerCase()} `;
  // Longest terms first, so "adopted budget" goes before "budget" can split it.
  const terms = [...group.textRes].sort((x, y) => y.term.length - x.term.length);
  for (const { re } of terms) a = a.replace(new RegExp(re.source, "gi"), " ");
  return a
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !FILLER.has(w) && !/^(fy)?\d+[a-z]{0,2}$/.test(w)).length;
}

/**
 * The features of one link for one keyword group, or null when none of the group's terms
 * appears in the link text, URL, heading or nearby text (the link then scores 0 for it, as
 * with the rules).
 */
export function groupFeatures(link: LinkCandidate, ctx: ScoreContext, group: CompiledGroup, base: LinkScore): GroupFeatures | null {
  const u = new URL(link.url);
  // A group at weight 0 is switched off, as with the rules.
  if (group.weight <= 0) return null;
  const { inAnchor, inUrl, inHost, inHeading, inContext } = groupMatches(group, link, u);
  if (!inAnchor && !inUrl && !inHeading && !inContext) return null;
  const w = group.weight;
  const docGroup = group.kind === "document";
  const isDoc = base.type === "document";
  const anchor = link.anchor.trim();
  const words = anchor ? anchor.split(/\s+/).length : 0;
  const fileName = u.pathname.split("/").pop() ?? "";
  const paperWords = `${link.anchor} ${link.titleAttr} ${urlWords(fileName)}`;
  const fullName = !!inAnchor && inAnchor.split(" ").length >= 3;
  const extra = inAnchor ? extraAnchorWords(link.anchor, group) : 0;
  const parent = Math.max(0, Math.min(1, ctx.parentPathScore));

  const values: Record<FeatureName, number> = {
    anchor_full_name: fullName ? w : 0,
    anchor_term: inAnchor && !fullName ? w : 0,
    anchor_clean_name: inAnchor && extra === 0 ? w : 0,
    anchor_extra_words: inAnchor ? Math.min(extra, 4) / 4 : 0,
    url_term: inUrl ? w : 0,
    heading_term: inHeading ? w : 0,
    context_term: inContext ? w : 0,
    only_nearby_text: !inAnchor && !inUrl && !isYearOnlyAnchor(link.anchor) ? w : 0,
    year_only_anchor: isYearOnlyAnchor(link.anchor) && !inAnchor && (inHeading || inContext) ? w : 0,
    host_term: inHost ? w : 0,
    contact_group: bool(!docGroup),
    document_file: bool(isDoc),
    file_for_contact: bool(isDoc && !docGroup),
    own_site_page_for_document: bool(!isDoc && ctx.internal && docGroup),
    other_platform_page_for_document: bool(!isDoc && !ctx.internal && docGroup),
    parent_path_score: parent,
    in_menu: bool(link.boilerplate),
    supporting_paper: bool(docGroup && SUPPORTING_PAPER.test(paperWords)),
    other_government_site: bool(docGroup && onOtherGovernmentSite(link.url, ctx.internal)),
    has_year: bool(base.fiscalYear !== null),
    no_link_text: bool(!anchor),
    long_link_text: bool(words > 8),
  };
  const labels: Partial<Record<FeatureName, string>> = {
    anchor_full_name: `'${inAnchor}' in the link text, a full name`,
    anchor_term: `'${inAnchor}' in the link text`,
    anchor_clean_name: "the link text is just the name and year",
    anchor_extra_words: `${extra} other word${extra === 1 ? "" : "s"} in the link text`,
    url_term: `'${inUrl}' in the URL or file name`,
    heading_term: `heading '${link.heading.slice(0, 60)}' names it`,
    context_term: `'${inContext}' in the nearby text`,
    only_nearby_text: "the keyword is only near the link, not in its text or URL",
    year_only_anchor: "the link text is only a year, under a heading that names it",
    host_term: `'${inHost}' in the host name`,
    contact_group: "a contact title",
    document_file: `${(base.fileType ?? "file").toUpperCase()} document`,
    file_for_contact: "a file, not a person's page",
    own_site_page_for_document: "a page on the entity's site, more likely a list of documents",
    other_platform_page_for_document: "a page on another platform, likely a document viewer",
    parent_path_score: `found on a page with path score ${parent.toFixed(2)}`,
    in_menu: "in a menu, header or footer",
    supporting_paper: "a paper about the document, not the document itself",
    other_government_site: `on another government's site (${u.hostname})`,
    has_year: `names fiscal year ${base.fiscalYear}`,
    no_link_text: "no link text",
    long_link_text: "long link text, like a headline",
  };
  return { group, values, labels };
}

export const toVector = (values: Record<FeatureName, number>) => FEATURES.map((f) => values[f]);
export const asLogistic = (m: LearnedModel): LogisticModel => ({ bias: m.bias, weights: toVector(m.weights) });

/**
 * Scores one link with the learned weights. Type, file type, year, noise and the path score
 * (which orders the crawl queue) come from the rules; the target score comes from the model.
 */
export function scoreLinkLearned(link: LinkCandidate, ctx: ScoreContext, model: LearnedModel): LinkScore {
  const base = scoreLink(link, ctx);
  if (base.noise) return base;
  const lm = asLogistic(model);
  let best: { f: GroupFeatures; z: number } | null = null;
  for (const g of ctx.groups) {
    const f = groupFeatures(link, ctx, g, base);
    if (!f) continue;
    const z = logit(lm, toVector(f.values));
    if (!best || z > best.z) best = { f, z };
  }
  if (!best) return base;

  const p = sigmoid(best.z);
  let score = p;
  const policy: string[] = [];
  if (best.f.group.kind === "document") {
    const now = ctx.now ?? new Date();
    const mult = recencyMultiplier(base.fiscalYear, now);
    if (mult < 1) {
      score *= mult;
      policy.push(`fiscal year ${base.fiscalYear} (x${mult.toFixed(2)})`);
    }
    if (base.isDraft) {
      score *= 0.85;
      policy.push("draft (x0.85)");
    }
  }
  // The pieces of evidence that moved the score most, in log-odds.
  const parts = FEATURES.filter((f) => best!.f.values[f] !== 0)
    .map((f) => ({ label: best!.f.labels[f]!, c: model.weights[f] * best!.f.values[f] }))
    .filter((x) => Math.abs(x.c) >= 0.05)
    .sort((a, b) => Math.abs(b.c) - Math.abs(a.c))
    .slice(0, 5)
    .map((x) => `${x.label} (${x.c >= 0 ? "+" : ""}${x.c.toFixed(1)})`);
  const target = Math.round(Math.max(0, Math.min(1, score)) * 1000) / 1000;
  return {
    ...base,
    targetScore: target,
    docType: target >= 0.15 ? best.f.group.key : null,
    reason: `learned: ${p.toFixed(2)} likely '${best.f.group.key}'. ${parts.join("; ")}${policy.length ? `; ${policy.join("; ")}` : ""}`,
    decidedBy: "learned",
  };
}
