import type { LinkCandidate } from "../crawler/extract.js";
import { recencyMultiplier } from "./fileinfo.js";
import type { CompiledGroup } from "./keywords.js";
import type { CallInfo, LlmClient } from "./llm.js";
import { type LinkScore, UNSURE_HIGH, UNSURE_LOW } from "./rules.js";

/**
 * The LLM tier: links the rules scored between 0.2 and 0.7 go to the LLM in batches of up to 50,
 * as short records. A batch whose call fails keeps its rules scores. Changes `scored` in place.
 */
export async function applyLlmTier(
  llm: LlmClient,
  groups: CompiledGroup[],
  scored: { link: LinkCandidate; s: LinkScore }[],
  onCall?: (c: CallInfo) => void,
  now = new Date(),
): Promise<number> {
  if (!llm.enabled) return 0;
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
      // The LLM says whether it is the target; the newest year and the final version still
      // rank first, so the same multipliers as the rules apply.
      let target = a.target_score;
      const notes: string[] = [];
      if (groups.find((g) => g.key === a.doc_type)?.kind === "document") {
        const m = recencyMultiplier(x.s.fiscalYear, now);
        if (m < 1) {
          target *= m;
          notes.push(`fiscal year ${x.s.fiscalYear} (x${m.toFixed(2)})`);
        }
        if (x.s.isDraft) {
          target *= 0.85;
          notes.push("draft (x0.85)");
        }
        if (x.s.type === "page" && x.s.internal) {
          // A page on the entity's own site about budgets is nearly always the list of budgets.
          target *= 0.6;
          notes.push("a page on the entity's site, likely the list rather than the document (x0.60)");
        }
      }
      x.s = {
        ...x.s,
        targetScore: Math.round(target * 1000) / 1000,
        docType: a.doc_type,
        pathScore: x.s.type === "page" ? Math.max(x.s.pathScore, a.path_score) : 0,
        reason: `LLM: ${a.reason}${notes.length ? `; ${notes.join("; ")}` : ""} (rules said ${before.toFixed(2)}: ${x.s.reason})`,
        decidedBy: "llm",
      };
      decided++;
    }
  }
  return decided;
}
