import type { LinkCandidate } from "../crawler/extract.js";
import { recencyMultiplier } from "./fileinfo.js";
import type { CompiledGroup } from "./keywords.js";
import type { CallInfo, LlmClient } from "./llm.js";
import { type LinkScore, UNSURE_HIGH, UNSURE_LOW } from "./rules.js";

type Scored = { link: LinkCandidate; s: LinkScore };

/**
 * A confirmed target's score: its confidence times the same multipliers the rules use, so the
 * newest year, the final version and the document itself (not a paper about it, not the page
 * that lists it) still rank first.
 */
function confirmedScore(x: Scored, confidence: number, documentGroup: boolean, now: Date): { score: number; notes: string[] } {
  let score = confidence;
  const notes: string[] = [];
  if (!documentGroup) return { score, notes };
  const m = recencyMultiplier(x.s.fiscalYear, now);
  if (m < 1) {
    score *= m;
    notes.push(`fiscal year ${x.s.fiscalYear} (x${m.toFixed(2)})`);
  }
  if (x.s.isDraft) {
    score *= 0.85;
    notes.push("draft (x0.85)");
  }
  if (x.s.supportingPaper) {
    score *= 0.6;
    notes.push("a paper about the document, not the document itself (x0.60)");
  }
  if (x.s.type === "page" && x.s.internal) {
    // A page on the entity's own site about budgets is nearly always the list of budgets.
    score *= 0.6;
    notes.push("a page on the entity's site, likely the list rather than the document (x0.60)");
  }
  return { score, notes };
}

/**
 * The LLM tier: links the rules scored between 0.2 and 0.7 go to the LLM in batches of up to 50,
 * as short records. A batch whose call fails keeps its rules scores. Changes `scored` in place.
 *
 * Links the rules are sure about (0.7 or more) are not sent. They count as confirmed and are put
 * on the same scale as an LLM confirmation, so an older year the LLM lifted never outranks a
 * newer one the rules were already sure about.
 */
export async function applyLlmTier(
  llm: LlmClient,
  groups: CompiledGroup[],
  scored: Scored[],
  onCall?: (c: CallInfo) => void,
  now = new Date(),
): Promise<number> {
  if (!llm.enabled) return 0;
  const isDocGroup = (key: string | null) => groups.find((g) => g.key === key)?.kind === "document";

  const unsure = scored.filter((x) => x.s.targetScore >= UNSURE_LOW && x.s.targetScore < UNSURE_HIGH);
  let decided = 0;
  for (let i = 0; i < unsure.length; i += 50) {
    const batch = unsure.slice(i, i + 50);
    const answer = await llm.classifyLinks(
      batch.map((x, j) => ({ i: j, url: x.link.url, anchor: x.link.anchor || x.link.titleAttr, heading: x.link.heading, context: x.link.context })),
      groups,
      onCall,
    );
    if (!answer) continue;
    for (const a of answer) {
      const x = batch[a.i];
      if (!x) continue;
      const before = x.s.targetScore;
      const { score, notes } = confirmedScore(x, a.target_score, isDocGroup(a.doc_type), now);
      x.s = {
        ...x.s,
        targetScore: Math.round(score * 1000) / 1000,
        docType: a.doc_type,
        pathScore: x.s.type === "page" ? Math.max(x.s.pathScore, a.path_score) : 0,
        reason: `LLM: ${a.reason}${notes.length ? `; ${notes.join("; ")}` : ""} (rules said ${before.toFixed(2)}: ${x.s.reason})`,
        decidedBy: "llm",
      };
      decided++;
    }
  }

  for (const x of scored) {
    if (x.s.decidedBy === "llm" || x.s.targetScore < UNSURE_HIGH || !isDocGroup(x.s.docType)) continue;
    const { score } = confirmedScore(x, 1, true, now);
    if (score > x.s.targetScore) {
      x.s = { ...x.s, targetScore: Math.round(score * 1000) / 1000, reason: `${x.s.reason}; sure by rules, scored as confirmed (${score.toFixed(2)})` };
    }
  }
  return decided;
}
