/** Year, draft status and fiscal-year helpers for document links. */

const MIN_YEAR = 1990;
const MAX_YEAR = 2040;
const valid = (y: number) => y >= MIN_YEAR && y <= MAX_YEAR;
const fullYear = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));

/**
 * Fiscal year named in one piece of text, by the strongest pattern found:
 * 1. a fiscal year end: "June 30, 2025", "6-30-25"
 * 2. "FY2026", "FY 26", "Fiscal Year 2025"
 * 3. a range of two consecutive years: "2025-26", "2026-2027" (named by the end year)
 * 4. a bare year: "2025acfrfinal"
 */
export function fiscalYearIn(text: string): number | null {
  if (!text) return null;
  const t = text.replace(/[‐-―]/g, "-");

  const end = t.match(/june\s+30,?\s*((?:19|20)\d{2})/i) ?? t.match(/(?<!\d)0?6[-_./]30[-_./]((?:19|20)?\d{2})(?!\d)/);
  if (end) {
    const y = fullYear(end[1]!);
    if (valid(y)) return y;
  }
  const fy = t.match(/(?<![a-z])(?:fy|fiscal\s+year)\s*[-_]?\s*((?:19|20)?\d{2})(?!\d)/i);
  if (fy) {
    const y = fullYear(fy[1]!);
    if (valid(y)) return y;
  }
  for (const m of t.matchAll(/(?<!\d)((?:19|20)\d{2})\s*[-_/]\s*((?:19|20)?\d{2})(?!\d)/g)) {
    const a = Number(m[1]);
    const b = fullYear(m[2]!.length === 2 ? `${String(a).slice(0, 2)}${m[2]}` : m[2]!);
    if (b === a + 1 && valid(b)) return b;
  }
  const bare = t.match(/(?<!\d)((?:19|20)\d{2})(?!\d)/);
  if (bare) {
    const y = Number(bare[1]);
    if (valid(y)) return y;
  }
  return null;
}

/** First fiscal year found, trying the sources in order (anchor first, heading last). */
export function fiscalYear(sources: string[]): number | null {
  for (const s of sources) {
    const y = fiscalYearIn(s);
    if (y) return y;
  }
  return null;
}

/** Fiscal year in progress on a date, for a July-to-June year: November 2026 is FY2027. */
export function currentFiscalYear(now: Date): number {
  return now.getMonth() >= 6 ? now.getFullYear() + 1 : now.getFullYear();
}

/** 1.0 for this year's and last year's documents, then 0.08 less per year, down to 0.6. */
export function recencyMultiplier(year: number | null, now: Date): number {
  if (!year) return 1;
  const current = currentFiscalYear(now);
  if (year > current + 1) return 0.9; // a year from the future is more likely a typo than a plan
  const age = current - 1 - year;
  return age <= 0 ? 1 : Math.max(0.6, 1 - 0.08 * age);
}

export function isDraft(texts: string[]): boolean {
  return texts.some((t) => /(?<![a-z])draft(?![a-z])/i.test(t.replace(/[_-]/g, " ")));
}

/** An anchor that is only a year or a fiscal year, such as "Fiscal Year 2025" or "FY 2027". */
export function isYearOnlyAnchor(anchor: string): boolean {
  const a = anchor.trim().toLowerCase().replace(/\(?pdf\)?|\(?xlsx?\)?|\s*\d+(\.\d+)?\s*(kb|mb)\b/g, "").trim();
  return /^(fiscal\s+year|fy|year)?\s*((19|20)\d{2}|\d{2})(\s*[-–/]\s*((19|20)?\d{2}))?$/.test(a);
}
