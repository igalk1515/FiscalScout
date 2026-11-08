import { z } from "zod";

export const KeywordGroupSchema = z.object({
  /** How much this group matters, from 0 to 1. */
  weight: z.number().min(0).max(1).default(1),
  /** Other ways the same thing is written. "CAFR" was the name of the ACFR until 2021. */
  synonyms: z.array(z.string().min(2).max(100)).max(50).default([]),
  /** "document" groups describe files; "contact" groups describe people's titles. */
  kind: z.enum(["document", "contact"]).default("document"),
});

export const KeywordsSchema = z
  .record(z.string().min(2).max(80), KeywordGroupSchema)
  .refine((o) => Object.keys(o).length >= 1 && Object.keys(o).length <= 30, {
    message: "between 1 and 30 keyword groups",
  });

export type KeywordGroup = z.infer<typeof KeywordGroupSchema>;
export type KeywordConfig = z.infer<typeof KeywordsSchema>;

export const DEFAULT_KEYWORDS: KeywordConfig = {
  acfr: {
    weight: 1,
    kind: "document",
    synonyms: [
      "cafr",
      "annual comprehensive financial report",
      "comprehensive annual financial report",
      "annual financial report",
      "audited financial statements",
    ],
  },
  budget: {
    weight: 1,
    kind: "document",
    synonyms: [
      "adopted budget",
      "proposed budget",
      "recommended budget",
      "budget book",
      "operating budget",
      "capital improvement plan",
      "capital budget",
    ],
  },
  "single audit": {
    weight: 0.7,
    kind: "document",
    synonyms: ["federal awards", "uniform guidance"],
  },
  "finance director": {
    weight: 0.9,
    kind: "contact",
    synonyms: [
      "chief financial officer",
      "cfo",
      "director of finance",
      "finance manager",
      "treasurer",
      "comptroller",
      "controller",
      "budget manager",
      "budget director",
      "business manager",
    ],
  },
};

export interface CompiledGroup {
  key: string;
  weight: number;
  kind: "document" | "contact";
  terms: string[];
  textRes: { term: string; re: RegExp }[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function termRegex(term: string): RegExp {
  const words = term.trim().toLowerCase().split(/\s+/).map(escape);
  const plural = /[a-z]$/.test(term) ? "s?" : "";
  return new RegExp(`(?<![a-z0-9])${words.join("[\\s\\-_/]+")}${plural}(?![a-z0-9])`, "i");
}

export function compileKeywords(cfg: KeywordConfig): CompiledGroup[] {
  return Object.entries(cfg).map(([key, g]) => {
    const terms = [...new Set([key, ...g.synonyms].map((t) => t.trim().toLowerCase()).filter(Boolean))];
    return { key, weight: g.weight, kind: g.kind, terms, textRes: terms.map((term) => ({ term, re: termRegex(term) })) };
  });
}

/** First term of the group found in the text, matched on word boundaries. */
export function matchText(group: CompiledGroup, text: string): string | null {
  if (!text) return null;
  for (const { term, re } of group.textRes) if (re.test(text)) return term;
  return null;
}

/** Splits a URL part into lowercase words: "FY26-Budget_Book.pdf" -> "fy26 budget book pdf". */
export function urlWords(part: string): string {
  let s = part;
  try {
    s = decodeURIComponent(part);
  } catch {
    // keep as is
  }
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * First term found in a URL part. Long terms may sit inside run-together words such as
 * "2025acfrfinal"; short ones like "cfo" must be a whole word, as in "cfo.asu.edu".
 */
export function matchUrlPart(group: CompiledGroup, part: string): string | null {
  const words = urlWords(part);
  if (!words) return null;
  const tokens = new Set(words.split(" "));
  const squashed = words.replace(/ /g, "");
  for (const term of group.terms) {
    const t = term.replace(/[^a-z0-9 ]+/g, " ").trim();
    if (!t) continue;
    if (t.includes(" ")) {
      if (` ${words} `.includes(` ${t} `) || squashed.includes(t.replace(/ /g, ""))) return term;
    } else if (t.length >= 4) {
      if (squashed.includes(t)) return term;
    } else if (tokens.has(t)) {
      return term;
    }
  }
  return null;
}
