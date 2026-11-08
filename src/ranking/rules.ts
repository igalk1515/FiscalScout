import type { LinkCandidate } from "../crawler/extract.js";
import { DOCUMENT_TYPES, fileTypeFromUrl } from "../crawler/url.js";
import { fiscalYear, isDraft, isYearOnlyAnchor, recencyMultiplier } from "./fileinfo.js";
import { type CompiledGroup, matchText, matchUrlPart, urlWords } from "./keywords.js";

export const RANKER_VERSION = "rules-1";

/** Links scored between these two values are unsure: the LLM tier decides them when it is on. */
export const UNSURE_LOW = 0.2;
export const UNSURE_HIGH = 0.7;

export interface LinkScore {
  type: "document" | "page";
  fileType: string | null;
  docType: string | null;
  fiscalYear: number | null;
  isDraft: boolean;
  /** Is this link itself a result: the budget, the ACFR, the finance contact page? */
  targetScore: number;
  /** Does this link lead to results? The frontier queue is ordered by it. */
  pathScore: number;
  matchedKeywords: string[];
  reason: string;
  noise: boolean;
  /** Set to "llm" when the LLM tier replaced the rules score. */
  decidedBy?: "rules" | "llm";
  /** The link points inside the crawl's scope. */
  internal?: boolean;
  /** A paper about a document ("Budget Responses", "Hearing Notice"), not the document itself. */
  supportingPaper?: boolean;
}

export interface ScoreContext {
  groups: CompiledGroup[];
  /** Path score of the page the link was found on. */
  parentPathScore: number;
  /** The link points inside the crawl's scope (the entity's own site). */
  internal: boolean;
  /** Content type learned from a fetch, for URLs whose extension says nothing. */
  contentTypeFileType?: string | null;
  now?: Date;
}

export const SOCIAL_HOSTS =
  /(^|\.)(facebook|twitter|x|instagram|youtube|youtu|linkedin|tiktok|nextdoor|flickr|pinterest|threads|vimeo|snapchat)\.(com|be|net)$/i;
const NOISE_WORDS =
  /(?<![a-z])(log ?in|sign ?in|sign ?up|register|subscribe|translate|privacy|cookies?|accessibility statement|skip to|print|share|calendar|events?|news|press releases?|weather|parking tickets?)(?![a-z])/i;

/** Phrases that almost always name the page that lists finance documents. */
const VERY_STRONG_HUB =
  /(?<![a-z])(financial reports?|financial statements?|financial transparency|budget documents?|budget office|office of (management and )?budget|finance department|department of finance|business (and|&) finance|business (and|&) financial services|annual reports?|audit reports?)(?![a-z])/i;
/** Course and degree pages: "Finance (BS)" is a program, not the finance office. */
const ACADEMIC =
  /(?<![a-z])(degrees?|bachelor'?s?|master'?s?|mba|ph ?d|majors?|minors?|programs?|courses?|classes|certificates?|admissions?|apply|tuition|curriculum|online learning|students?|faculty|research)(?![a-z])/i;
/** Words that mark a page as a likely hub on the way to finance documents. */
const STRONG_HUB =
  /(?<![a-z])(finance|financial|financials|budgets?|treasurer|treasury|accounting|fiscal|transparency|comptroller|controller|business (and|&) finance|business services|business (and|&) financial services|administrative services|audits?)(?![a-z])/i;
const WEAK_HUB =
  /(?<![a-z])(departments?|government|administration|city hall|about|leadership|documents?|document center|reports|publications|open data|directory|staff|offices?|board|council|agendas?|minutes)(?![a-z])/i;

/** Papers about a document rather than the document: "FY27 Budget Responses", "Budget Hearing Notice". */
const SUPPORTING_PAPER =
  /(?<![a-z])(responses?|questions?|q ?& ?a|faq|memos?|memorandum|presentations?|slides|hearings?|notices?|agendas?|minutes|survey|resolutions?|amendments?|transmittal|timeline|calendar|work ?sessions?|press release|public comment|workshop)(?![a-z])/i;

const round = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 1000) / 1000;

/**
 * Scores one link with weighted rule signals. Every score comes with the list of signals that
 * produced it, so any result can be explained.
 */
export function scoreLink(link: LinkCandidate, ctx: ScoreContext): LinkScore {
  const now = ctx.now ?? new Date();
  const u = new URL(link.url);
  const fromUrl = fileTypeFromUrl(link.url);
  const fileType = ctx.contentTypeFileType ?? (fromUrl === "media" ? "media" : fromUrl);
  const isDoc = !!fileType && DOCUMENT_TYPES.has(fileType);
  const type: "document" | "page" = isDoc ? "document" : "page";

  const anchor = link.anchor;
  const pathPart = `${u.pathname} ${u.search}`;
  const fileName = u.pathname.split("/").pop() ?? "";
  const year = fiscalYear([anchor, link.titleAttr, urlWords(fileName), urlWords(u.pathname), link.heading, link.context]);
  const draft = isDraft([anchor, link.titleAttr, u.pathname]);
  const yearOnly = isYearOnlyAnchor(anchor);

  const firstSegment = u.pathname.split("/").filter(Boolean)[0] ?? "";
  const noise =
    fileType === "media" ||
    SOCIAL_HOSTS.test(u.hostname) ||
    (NOISE_WORDS.test(anchor) && !STRONG_HUB.test(anchor)) ||
    NOISE_WORDS.test(urlWords(firstSegment));

  const matched = new Set<string>();
  let best = { key: null as string | null, kind: "document" as "document" | "contact", target: 0, notes: [] as string[] };
  let bestPath = { value: 0, notes: [] as string[] };

  for (const g of ctx.groups) {
    const inAnchor = matchText(g, anchor);
    const inUrl = matchUrlPart(g, pathPart) ?? (link.titleAttr ? matchText(g, link.titleAttr) : null);
    const inHost = matchUrlPart(g, u.hostname.split(".").slice(0, -2).join(" "));
    const inHeading = matchText(g, link.heading);
    const inContext = inHeading ? null : matchText(g, link.context);
    for (const m of [inAnchor, inUrl, inHost, inHeading, inContext]) if (m) matched.add(m);

    // Target score: is this link the thing itself?
    const notes: string[] = [];
    let t = 0;
    if (inAnchor) {
      // A full official name ("annual comprehensive financial report") is stronger evidence
      // than a short word.
      const a = inAnchor.split(" ").length >= 3 ? 0.45 : 0.35;
      t += a * g.weight;
      notes.push(`'${inAnchor}' in the link text (+${(a * g.weight).toFixed(2)})`);
    }
    if (inUrl) {
      t += 0.25 * g.weight;
      notes.push(`'${inUrl}' in the URL or file name (+${(0.25 * g.weight).toFixed(2)})`);
    }
    if (inHeading) {
      t += 0.15 * g.weight;
      notes.push(`heading '${link.heading.slice(0, 60)}' names it (+${(0.15 * g.weight).toFixed(2)})`);
    } else if (inContext) {
      t += 0.1 * g.weight;
      notes.push(`'${inContext}' in the nearby text (+${(0.1 * g.weight).toFixed(2)})`);
    }
    if (yearOnly && !inAnchor && (inHeading || inContext)) {
      t += 0.2 * g.weight;
      notes.push(`the link text is only a year, under a heading that names it (+${(0.2 * g.weight).toFixed(2)})`);
    }
    if (t > best.target) best = { key: g.key, kind: g.kind, target: t, notes };

    // Path score: does this link lead to results?
    const pNotes: string[] = [];
    let p = 0;
    if (inAnchor) {
      p += 0.4 * g.weight;
      pNotes.push(`'${inAnchor}' in the link text`);
    }
    const urlHit = inUrl ?? inHost;
    if (urlHit) {
      p += 0.3 * g.weight;
      pNotes.push(inUrl ? `'${inUrl}' in the URL` : `'${inHost}' in the host name`);
    }
    if (inHeading) {
      p += 0.1 * g.weight;
      pNotes.push("heading names it");
    }
    if (p > bestPath.value) bestPath = { value: p, notes: pNotes };
  }

  // ---- target score
  let target = best.target;
  let supportingPaper = false;
  const notes = [...best.notes];
  if (target > 0) {
    if (isDoc) {
      target += 0.15;
      notes.push(`${fileType!.toUpperCase()} document (+0.15)`);
    } else if (!ctx.internal && best.kind === "document" && notes.some((n) => n.includes("link text"))) {
      target += 0.1;
      notes.push("a page on another platform named for the document, likely a document viewer (+0.10)");
    } else if (ctx.internal && best.kind === "document") {
      target -= 0.15;
      notes.push("a page on the entity's site, more likely a list of documents than the document (-0.15)");
    }
    if (ctx.parentPathScore > 0) {
      target += 0.1 * ctx.parentPathScore;
      notes.push(`found on a page with path score ${ctx.parentPathScore.toFixed(2)} (+${(0.1 * ctx.parentPathScore).toFixed(2)})`);
    }
    if (draft) {
      target -= 0.15;
      notes.push("marked as a draft (-0.15)");
    }
    if (link.boilerplate) {
      target -= 0.2;
      notes.push("in a menu, header or footer (-0.20)");
    }
    // Multipliers come after the sum is capped at 1, so they still separate links whose sum
    // went past 1 (otherwise FY2026 and FY2025 budgets would both sit at 1.00).
    target = Math.min(1, target);
    const paperWords = `${anchor} ${link.titleAttr} ${urlWords(fileName)}`;
    supportingPaper = best.kind === "document" && SUPPORTING_PAPER.test(paperWords);
    if (supportingPaper) {
      target *= 0.6;
      notes.push(`a paper about the document ('${paperWords.match(SUPPORTING_PAPER)![0]}'), not the document itself (x0.60)`);
    }
    if (best.kind === "document") {
      const mult = recencyMultiplier(year, now);
      if (mult < 1) {
        target *= mult;
        notes.push(`fiscal year ${year} (x${mult.toFixed(2)})`);
      }
    }
  }
  if (noise) {
    target = 0;
    notes.push("noise: social, login, calendar or media link");
  }

  // ---- path score
  let path = 0;
  const pNotes: string[] = [];
  if (!isDoc && !noise) {
    path = bestPath.value;
    pNotes.push(...bestPath.notes);
    const hubText = `${anchor} ${urlWords(u.pathname)}`;
    if (VERY_STRONG_HUB.test(hubText)) {
      path += 0.4;
      pNotes.push("names a finance documents page");
    } else if (STRONG_HUB.test(hubText)) {
      path += 0.25;
      pNotes.push("finance hub words");
    } else if (WEAK_HUB.test(hubText)) {
      path += 0.12;
      pNotes.push("navigation words");
    }
    if (ACADEMIC.test(`${hubText} ${u.hostname.split(".")[0]}`)) {
      path -= 0.3;
      pNotes.push("a degree, course or student page (-0.30)");
    }
    if (ctx.parentPathScore > 0) path += 0.15 * ctx.parentPathScore;
    if (link.boilerplate) path -= 0.05;
  } else if (noise && !isDoc) {
    path = 0.02;
  }

  target = round(target);
  return {
    type,
    fileType: fileType === "media" ? null : fileType,
    docType: target >= 0.15 ? best.key : null,
    fiscalYear: year,
    isDraft: draft,
    targetScore: target,
    pathScore: round(path),
    matchedKeywords: [...matched],
    reason: target > 0 ? notes.join("; ") : pNotes.length ? `path: ${pNotes.join(", ")}` : "no signal",
    noise,
    internal: ctx.internal,
    supportingPaper,
  };
}
