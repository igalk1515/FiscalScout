import type { LinkCandidate } from "../crawler/extract.js";
import { LEARNED_RANKER, scoreLinkLearned } from "./learned.js";
import { LEARNED_MODEL } from "./learned-weights.js";
import { type LinkScore, RANKER_VERSION, type ScoreContext, scoreLink } from "./rules.js";

/** The two rankers a crawl can use. Both are stored on the crawl as a version string. */
export type RankerName = "learned" | "rules";
export const RANKER_NAMES = ["learned", "rules"] as const;
export const DEFAULT_RANKER: RankerName = "learned";

export const rankerVersion = (name: RankerName) => (name === "learned" ? LEARNED_RANKER : RANKER_VERSION);
export const rankerName = (version: string): RankerName => (version.startsWith("learned") ? "learned" : "rules");

/** Scores one link with the crawl's ranker. */
export function rankLink(link: LinkCandidate, ctx: ScoreContext, version: string): LinkScore {
  return rankerName(version) === "learned" ? scoreLinkLearned(link, ctx, LEARNED_MODEL) : scoreLink(link, ctx);
}
