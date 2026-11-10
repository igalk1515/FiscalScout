import type { CheerioAPI } from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { blockText, cleanText } from "../crawler/extract.js";
import { type CompiledGroup, matchText } from "./keywords.js";
import type { CallInfo, LlmClient, LlmContact } from "./llm.js";

export interface Contact {
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  score: number;
  matchedKeywords: string[];
  /** The block of page text every field was checked against. */
  snippet: string;
  decidedBy: "rules" | "llm";
}

export interface ContactContext {
  groups: CompiledGroup[];
  /** Registrable domain of the entity: an email on it is a good sign. */
  entityDomain: string;
  /** Path score of the page: a contact on the finance page matters more than one in a footer. */
  pagePathScore: number;
  llm?: LlmClient | null;
  onLlmCall?: (c: CallInfo) => void;
}

const MAX_BLOCK = 500;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const EMAIL_ONLY = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?:\s*(?:x|ext\.?)\s*\d{1,6})?/gi;
const HONORIFIC = /^(dr|mr|mrs|ms|miss|prof|hon)\.?\s+/i;
const TITLE_WORDS =
  /^(executive|vice|president|chief|director|officer|treasurer|manager|controller|comptroller|assistant|deputy|senior|associate|superintendent|coordinator|specialist|analyst|accountant|supervisor|head|dean|provost|cfo|ceo|coo|cio|business|finance|financial|budget|interim|acting|administrator|clerk|secretary|buyer|technician|bookkeeper|auditor|payroll|purchasing|procurement|accounting)$/i;
const NOT_NAME_WORDS =
  /^(department|office|services?|city|county|district|school|university|college|institute|center|centre|foundation|enterprise|learning|research|park|hall|building|campus|program|programs|chart|org|organization|plan|report|reports|budget|finance|financial|contact|us|email|phone|fax|address|street|suite|hours|monday|tuesday|wednesday|thursday|friday|the|and|of|for|staff|directory|board|team|division|information|welcome|learn|more|view|leadership|careers|jobs|online|news|about|home|page|human|resources|accounts|payable|receivable|benefits|operations|transportation|technology|nutrition|maintenance|facilities|communications|education|special|employees?)$/i;
/** A job title has a role word; "Payroll" alone is a department, "Payroll Manager" a person's title. */
const ROLE_WORD =
  /(?<![a-z])(chief|director|manager|officer|head|supervisor|coordinator|specialist|analyst|accountant|bookkeeper|auditor|clerk|secretary|assistant|administrator|controller|comptroller|treasurer|buyer|agent|technician|superintendent|cfo)(?![a-z])/i;
/** Titles that lead a team rank above the staff in it. */
const LEADER_WORD = /(?<![a-z])(chief|director|manager|officer|head|supervisor|administrator|controller|comptroller|treasurer|superintendent|cfo)(?![a-z])/i;
const DEPUTY_WORD = /(?<![a-z])(assistant|deputy|associate)(?![a-z])/i;
/** Someone who no longer holds the title. */
const FORMER_WORD = /(?<![a-z])(former|retired|emerit(us|a))(?![a-z])/i;
/** The name of an office, not a person's title: "Office of the State Treasurer", "Treasurer's Office". */
const OFFICE_NAME =
  /(office|department|bureau|division) of (the )?([a-z]+ ){0,2}(treasurer|controller|comptroller|finance|budget)\b|(treasurer|controller|comptroller)['’]s office/gi;
/** Department mailboxes: a way to reach an office, not a person's own email. */
const SHARED_LOCAL =
  /^(info|contact|contactus|webmaster|web|admin|office|help|helpdesk|support|hr|humanresources|payroll|purchasing|procurement|finance|accounting|accountspayable|ap|budget|business|businessoffice|questions|communications|media|press|records|openrecords|mail|general|customerservice|customer\.service|no-?reply)$/i;
const isShared = (email: string) => SHARED_LOCAL.test(email.split("@")[0] ?? "");

const SUFFIX_OR_CREDENTIAL = /^(phd|ph\.d\.|md|jd|mba|mpa|cpa|cgfo|cpfo|esq|jr|sr|ii|iii|iv)\.?$/i;

/**
 * A staff directory writes the last name first: "Hodnett, Melissa" or "Pettigrew, Michael J.".
 * Returns the name in reading order, or null when the part after the comma is not a first name
 * (a credential such as "CPA" or "PhD", or a suffix such as "Jr.").
 */
function lastNameFirst(parts: string[]): string | null {
  if (parts.length !== 2) return null;
  const [last, first] = parts as [string, string];
  if (!/^[A-Z][a-zA-Z'’-]+$/.test(last)) return null; // one word
  const given = first.split(/\s+/).filter(Boolean);
  if (given.length < 1 || given.length > 2) return null;
  if (!/^[A-Z][a-z][a-zA-Z'’-]*$/.test(given[0]!) || SUFFIX_OR_CREDENTIAL.test(given[0]!)) return null;
  if (given[1] && !/^([A-Z]\.|[A-Z][a-z][a-zA-Z'’-]*)$/.test(given[1])) return null;
  return `${given.join(" ")} ${last}`;
}

/** A person's name: two to four capitalized words, initials allowed, after honorifics and credentials are removed. */
export function cleanName(raw: string): string | null {
  let s = cleanText(raw).replace(/[,;:\-|]+$/, "").trim();
  s = s.replace(HONORIFIC, "");
  // Credentials after a comma: "Wesley Scott, CPA, RTSBA" -> "Wesley Scott". A directory's
  // "Hodnett, Melissa" -> "Melissa Hodnett".
  const parts = s.split(",").map((p) => p.trim());
  s = lastNameFirst(parts) ?? parts[0]!;
  const tokens = s.split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 4) return null;
  for (const t of tokens) {
    if (!/^([A-Z][a-zA-Z'’-]+|[A-Z]\.)$/.test(t)) return null;
    if (TITLE_WORDS.test(t) || NOT_NAME_WORDS.test(t)) return null;
    if (/^[A-Z]{2,}$/.test(t)) return null; // an acronym ("ASU"), not part of a name
  }
  if (/^[A-Z]\.$/.test(tokens[tokens.length - 1]!)) return null; // ends with an initial
  return tokens.join(" ");
}

export interface TitleMatch {
  term: string;
  group: CompiledGroup;
  re: RegExp;
  /** Matched a nearby title (payroll, purchasing), not the target title itself. */
  related: boolean;
}

/** The target titles of every group first; nearby titles only inside a job title. */
export function titleMatch(groups: CompiledGroup[], raw: string): TitleMatch | null {
  if (!raw) return null;
  const text = raw.replace(OFFICE_NAME, " ");
  for (const g of groups) for (const { term, re } of g.textRes) if (re.test(text)) return { term, group: g, re, related: false };
  if (!ROLE_WORD.test(text)) return null;
  for (const g of groups) for (const { term, re } of g.relatedRes) if (re.test(text)) return { term, group: g, re, related: true };
  return null;
}

/**
 * How close a title is to what the group asks for, from 0 to 1: the group's main titles 1.0,
 * its other titles 0.85, a nearby title 0.6 for a leader and 0.4 for staff. An assistant or
 * deputy of the target ("Assistant Finance Director") ranks a step below the target, and a
 * former holder of a title far below.
 */
export function titleRelevance(m: TitleMatch, title: string | null): number {
  const t = title ?? "";
  let r = m.related ? (LEADER_WORD.test(t) ? 0.6 : 0.4) : m.group.terms.slice(0, 3).includes(m.term) ? 1 : 0.85;
  if (!m.related && DEPUTY_WORD.test(t)) r *= 0.85;
  if (FORMER_WORD.test(t)) r *= 0.3;
  return r;
}

interface Parsed {
  name: string;
  title: string | null;
}

/** Reads "Name, Title", "Name / Title" on two lines, "Title Name", or "Name Title" from one block. */
export function parseContactLines(block: string, groups: CompiledGroup[]): Parsed[] {
  const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
  const out: Parsed[] = [];
  lines.forEach((line, i) => {
    const m = titleMatch(groups, line);
    if (!m) return;
    // (a) "Name, Title" or "Name - Title" on one line, after a label such as "Prepared by:"
    const split = line.match(/^(.{3,80}?)\s*(?:,|\s-\s|\s–\s|\|)\s*(.+)$/);
    if (split) {
      const left = split[1]!.includes(":") ? split[1]!.split(":").pop()! : split[1]!;
      const name = cleanName(left);
      if (name && titleMatch(groups, split[2]!)) {
        out.push({ name, title: cleanText(split[2]!) });
        return;
      }
    }
    // A line that names someone after a label ("Prepared by: ...") belongs to that person only.
    const labelled = /^[A-Za-z ]{2,30}:/.test(line);
    // (b) name on the line before: "Marti Praschan," / "Chief Financial Officer"
    if (i > 0 && !labelled) {
      const name = cleanName(lines[i - 1]!);
      if (name) {
        out.push({ name, title: line });
        return;
      }
    }
    // (c) title alone, name on the next line
    if (i + 1 < lines.length && line.length < 80 && !labelled) {
      const name = cleanName(lines[i + 1]!);
      if (name) {
        out.push({ name, title: line });
        return;
      }
    }
    // (d) "... Chief Financial Officer Marti Praschan ..." inside a sentence
    const re = m.re;
    const at = line.search(re);
    if (at >= 0) {
      const after = line.slice(at).replace(re, "");
      const nm = after.match(/^\s*,?\s*([A-Z][a-zA-Z'’-]+(?:\s+[A-Z]\.)?(?:\s+[A-Z][a-zA-Z'’-]+){1,2})/);
      const name = nm ? cleanName(nm[1]!) : null;
      if (name) {
        out.push({ name, title: cleanText(line.slice(at).match(re)![0]) });
        return;
      }
    }
    // (e) "Morgan R. Olsen Executive Vice President, Treasurer and CFO": name, then title words
    const tokens = line.replace(HONORIFIC, "").split(/\s+/);
    const firstTitle = tokens.findIndex((t) => TITLE_WORDS.test(t.replace(/[,.;:]$/, "")));
    if (firstTitle >= 2 && firstTitle <= 4) {
      const name = cleanName(tokens.slice(0, firstTitle).join(" "));
      if (name) out.push({ name, title: cleanText(tokens.slice(firstTitle).join(" ")) });
    }
  });
  return out;
}

const norm = (s: string) => cleanText(s).toLowerCase();
const digits = (s: string) => s.replace(/\D/g, "");

/** Keeps only the values that appear in the block, so the model cannot invent a contact. */
export function verifyAgainstBlock(c: LlmContact, block: string): LlmContact | null {
  const text = norm(block);
  const name = c.name ? cleanName(c.name) : null;
  if (!name) return null;
  // The page may write the name last name first, as a staff directory does: "Hodnett, Melissa".
  const words = name.split(" ");
  const lastFirst = `${words[words.length - 1]}, ${words.slice(0, -1).join(" ")}`.toLowerCase();
  if (!text.includes(name.toLowerCase()) && !text.includes(lastFirst)) return null;
  const titleOk = c.title && c.title.split(/\W+/).filter((w) => w.length >= 3).every((w) => text.includes(w.toLowerCase()));
  // A real address only: "[email protected]" is what a page shows in place of an email it hides
  // from bots, and hidden emails stay hidden.
  const emailOk = c.email && EMAIL_ONLY.test(c.email) && text.includes(c.email.toLowerCase()) && !isShared(c.email);
  const phoneOk = c.phone && digits(c.phone).length >= 7 && digits(block).includes(digits(c.phone));
  return { name, title: titleOk ? cleanText(c.title!) : null, email: emailOk ? c.email!.toLowerCase() : null, phone: phoneOk ? c.phone! : null };
}

/** Email links of people in an element: a department mailbox (purchasing@, info@) is not a second person. */
function personalMailtos($: CheerioAPI, el: Element): number {
  const links = $(el).find('a[href^="mailto:" i]').add($(el).is('a[href^="mailto:" i]') ? el : []);
  return links.filter((_, a) => !isShared(($(a).attr("href") ?? "").replace(/^mailto:\s*/i, "").split("?")[0]!)).length;
}

/** Finds small blocks of page text around titles and email links. */
function candidateBlocks($: CheerioAPI, groups: CompiledGroup[]): string[] {
  const seeds = new Set<Element>();
  $("body *").each((_, node) => {
    const el = node as Element;
    if (["script", "style", "noscript", "template"].includes(el.name)) return;
    const own = (el.children ?? [])
      .filter((c: AnyNode) => c.type === "text")
      .map((c) => (c as unknown as { data: string }).data)
      .join(" ");
    if (own.trim() && titleMatch(groups, cleanText(own))) seeds.add(el);
  });
  $('a[href^="mailto:" i]').each((_, el) => void seeds.add(el as Element));

  const blocks = new Set<string>();
  for (const seed of seeds) {
    if (blocks.size >= 60) break;
    // Climb while the block stays small, so the email next to the name is included.
    // Stop before the block takes in a second person's email.
    let best: Element = seed;
    let cur: Element | null = seed;
    while (cur && cur.type === "tag") {
      const len = cleanText($(cur).text()).length;
      if (len > MAX_BLOCK) break;
      if (personalMailtos($, cur) > 1 && cur !== seed) break;
      best = cur;
      // A table row is one record: in a staff directory, one person with their own phone.
      if (cur.name === "tr") break;
      cur = cur.parent as Element | null;
    }
    let text = blockText(best);
    // An email or phone that only appears in a link target is still on the page.
    $(best)
      .find('a[href^="mailto:" i], a[href^="tel:" i]')
      .add($(best).is('a[href^="mailto:" i], a[href^="tel:" i]') ? best : [])
      .each((_, a) => {
        const href = $(a).attr("href") ?? "";
        const value = decodeURIComponent(href.replace(/^(mailto|tel):/i, "").split("?")[0]!).trim();
        if (value && !text.includes(value)) text += `\n${href.toLowerCase().startsWith("tel:") ? "Phone" : "Email"}: ${value}`;
      });
    if (titleMatch(groups, text)) blocks.add(text);
  }
  return [...blocks];
}

/**
 * A title fit to show: without the person's name, without "is the" from a sentence, cut at the
 * end of the sentence, at most 100 characters.
 */
export function cleanTitle(raw: string, name: string): string | null {
  let t = cleanText(raw.replace(/&nbsp;/gi, " ").replace(name, ""));
  t = t.replace(/^[,;:\-\s]+/, "").replace(/^(is|was|serves as|as)\s+(the\s+|our\s+|a\s+)?/i, "");
  const end = t.search(/\.\s|\.$/);
  if (end > 0) t = t.slice(0, end);
  t = t.trim();
  if (!t) return null;
  return t.length > 100 ? `${t.slice(0, 99).trim()}…` : t;
}

/**
 * Email and phone for one person in a block: an email whose address contains the person's
 * name wins; otherwise the nearest email and phone in the lines after the name, and only when
 * the block names a single person.
 */
export function nearestReach(block: string, name: string, people: number): { email: string | null; phone: string | null } {
  const lines = block.split("\n");
  const nameAt = Math.max(0, lines.findIndex((l) => l.includes(name.split(" ")[0]!)));
  const parts = name.toLowerCase().split(" ").filter((p) => p.length > 1 && !p.endsWith("."));
  const allEmails = (block.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()).filter((e) => !isShared(e));
  const named = allEmails.find((e) => parts.some((p) => e.split("@")[0]!.includes(p)));
  const window = lines.slice(nameAt, nameAt + 5).join("\n");
  const nearEmail = (window.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()).find((e) => !isShared(e)) ?? null;
  const nearPhone = (window.match(PHONE_RE) ?? [])[0] ?? null;
  const single = people === 1;
  return {
    email: named ?? (single || allEmails.length === 1 ? nearEmail : null),
    phone: single && nearPhone ? cleanText(nearPhone) : null,
  };
}

/**
 * Score = how relevant the title is (group weight x title relevance) x how complete and
 * trustworthy the contact is (email, an email on the entity's domain, phone, found on a
 * finance page). Relevance comes first: a payroll clerk with every detail still ranks below
 * the finance director without an email.
 */
function scoreContact(c: { title: string | null; email: string | null; phone: string | null }, m: TitleMatch, ctx: ContactContext): number {
  const email = c.email?.toLowerCase() ?? "";
  const sameDomain = !!email && (email.endsWith(`@${ctx.entityDomain}`) || email.endsWith(`.${ctx.entityDomain}`));
  const quality = Math.min(1, 0.6 + (email ? 0.2 : 0) + (sameDomain ? 0.05 : 0) + (c.phone ? 0.05 : 0) + (ctx.pagePathScore >= 0.5 ? 0.1 : 0));
  const s = m.group.weight * titleRelevance(m, c.title) * quality;
  return Math.round(Math.min(1, s) * 1000) / 1000;
}

/**
 * Finds finance contacts on a page. Rules find the blocks and read simple patterns; when the
 * LLM is on, it reads each block and every value it returns is checked against the block.
 */
export async function findContacts($: CheerioAPI, dataBlocks: string[], ctx: ContactContext): Promise<Contact[]> {
  const groups = ctx.groups.filter((g) => g.kind === "contact");
  if (!groups.length) return [];
  const blocks = [...candidateBlocks($, groups), ...dataBlocks.filter((b) => titleMatch(groups, b))].slice(0, 60);

  const found = new Map<string, Contact>();
  for (const block of blocks) {
    let people: { name: string; title: string | null; email: string | null; phone: string | null; by: "rules" | "llm" }[] = [];
    if (ctx.llm?.enabled) {
      const answer = await ctx.llm.extractContacts(block, ctx.onLlmCall);
      if (answer) {
        people = answer
          .map((c) => verifyAgainstBlock(c, block))
          .filter((c): c is LlmContact => !!c)
          .map((c) => ({ ...c, by: "llm" as const }));
      }
    }
    if (!people.length) {
      const parsed = parseContactLines(block, groups);
      people = parsed.map((p) => ({ ...p, ...nearestReach(block, p.name, parsed.length), by: "rules" as const }));
    }
    for (const p of people) {
      if (p.title) p.title = cleanTitle(p.title, p.name);
      const m = p.title ? titleMatch(groups, p.title) : titleMatch(groups, block);
      if (!m) continue; // not a relevant title
      if (m.related && !p.title) continue; // a nearby title must be the person's own title
      const contact: Contact = {
        name: p.name,
        title: p.title,
        email: p.email,
        phone: p.phone,
        score: scoreContact(p, m, ctx),
        // The group's name first, so contacts can be filtered by group ("finance director").
        matchedKeywords: [...new Set([m.group.key, m.term])],
        snippet: block.slice(0, 600),
        decidedBy: p.by,
      };
      const key = p.name.toLowerCase();
      const prev = found.get(key);
      if (!prev) found.set(key, contact);
      else {
        // Merge: keep what each sighting knows.
        const longerTitle = contact.title && (!prev.title || contact.title.length > prev.title.length) ? contact.title : prev.title;
        const merged = { ...prev, email: prev.email ?? contact.email, phone: prev.phone ?? contact.phone, title: longerTitle };
        const mm = (merged.title && titleMatch(groups, merged.title)) || m;
        merged.score = Math.max(prev.score, contact.score, scoreContact(merged, mm, ctx));
        found.set(key, merged);
      }
    }
  }
  return [...found.values()].sort((a, b) => b.score - a.score);
}
