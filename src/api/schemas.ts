import { z } from "zod";
import { KeywordsSchema } from "../ranking/keywords.js";

export const ErrorOut = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      param: z.string().optional(),
    }),
  })
  .describe("Every error has this shape");

export const CreateCrawlBody = z.object({
  url: z.string().url().describe("Start page, for example https://www.a2gov.org/"),
  keywords: KeywordsSchema.optional().describe(
    "Keyword groups: weight 0-1, synonyms, kind document|contact. Defaults to acfr, budget, single audit, finance director.",
  ),
  max_depth: z.number().int().min(0).max(5).default(3).describe("0 analyzes only the start page"),
  page_budget: z.number().int().min(1).max(5000).default(300).describe("Most pages fetched in this crawl"),
});

const Counters = z.object({
  pages_done: z.number(),
  pages_queued: z.number(),
  pages_fetching: z.number(),
  pages_failed: z.number(),
  pages_broken: z.number().describe("Failed pages that answered 404 or 410: broken links on the site"),
  pages_skipped: z.number(),
  results: z.number().describe("Links with a target score of at least 0.5"),
  documents: z.number(),
  contacts: z.number(),
  llm_calls: z.number(),
  llm_cost_usd: z.number(),
});

export const CrawlStatusEnum = z.enum(["queued", "running", "done", "blocked", "failed"]);

export const CrawlOut = z.object({
  id: z.string().uuid(),
  seed_url: z.string(),
  status: CrawlStatusEnum,
  status_detail: z.string().nullable(),
  keywords: z.record(z.any()),
  max_depth: z.number(),
  page_budget: z.number(),
  extra_hosts: z.array(z.string()),
  counters: Counters,
  now_fetching: z.array(z.string()),
  created_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  links: z.object({ self: z.string(), results: z.string(), contacts: z.string(), events: z.string(), live: z.string() }),
});

export const CrawlSummaryOut = z.object({
  id: z.string().uuid(),
  seed_url: z.string(),
  status: CrawlStatusEnum,
  status_detail: z.string().nullable(),
  pages_fetched: z.number(),
  created_at: z.string(),
  finished_at: z.string().nullable(),
});

export const IdParams = z.object({ id: z.string().uuid() });

const crawlOrHost = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object({
      crawl_id: z.string().uuid().optional().describe("Read results of this crawl"),
      host: z.string().min(3).optional().describe("Or: read the latest crawl of this site, e.g. a2gov.org"),
      ...shape,
    })
    .refine((q) => q.crawl_id || q.host, { message: "pass crawl_id or host", path: ["crawl_id"] });

export const LinksQuery = crawlOrHost({
  type: z.enum(["document", "page"]).optional(),
  doc_type: z.string().optional().describe("Keyword group, e.g. acfr or budget"),
  fiscal_year: z.coerce.number().int().optional(),
  min_score: z.coerce.number().min(0).max(1).default(0),
  keyword: z.string().optional().describe("Only links that matched this keyword"),
  q: z.string().min(2).optional().describe("Full-text search over link text and URL"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional().describe("next_cursor from the previous page"),
});

export const Source = z.object({
  page: z.string(),
  anchor_text: z.string().nullable(),
  section_heading: z.string().nullable(),
  context: z.string().nullable(),
  found_at: z.string(),
});

export const LinkOut = z.object({
  id: z.number(),
  url: z.string(),
  label: z.string().nullable(),
  type: z.string(),
  file_type: z.string().nullable(),
  doc_type: z.string().nullable(),
  fiscal_year: z.number().nullable(),
  is_draft: z.boolean(),
  needs_browser: z.boolean(),
  target_score: z.number(),
  path_score: z.number(),
  matched_keywords: z.array(z.string()),
  decided_by: z.string(),
  reason: z.string().nullable(),
  sources: z.array(Source),
});

const CrawlRef = z.object({ id: z.string(), seed_url: z.string(), status: z.string() });

export const LinksOut = z.object({ crawl: CrawlRef, data: z.array(LinkOut), next_cursor: z.string().nullable() });

export const LinkQuery = z.object({ crawl_id: z.string().uuid().optional() });

export const ContactsQuery = crawlOrHost({
  min_score: z.coerce.number().min(0).max(1).default(0),
  title: z.string().optional().describe("Part of the title, e.g. financial"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const ContactOut = z.object({
  id: z.number(),
  name: z.string(),
  title: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  score: z.number(),
  matched_keywords: z.array(z.string()),
  source_url: z.string().nullable(),
  source_snippet: z.string().nullable(),
  decided_by: z.string(),
});

export const ContactsOut = z.object({ crawl: CrawlRef, data: z.array(ContactOut) });

export const PagesQuery = z.object({
  status: z
    .enum(["queued", "fetching", "done", "failed", "skipped", "broken"])
    .optional()
    .describe("'broken' is the failed pages that answered 404 or 410"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export const PageOut = z.object({
  url: z.string(),
  status: z.string(),
  reason: z.string().nullable(),
  http_status: z.number().nullable(),
  depth: z.number(),
  path_score: z.number(),
  parent_url: z.string().nullable().describe("The page the link was found on"),
  attempts: z.number(),
  updated_at: z.string(),
});

export const PagesOut = z.object({ data: z.array(PageOut), next_cursor: z.string().nullable() });

export const EventsQuery = z.object({ after: z.coerce.number().int().min(0).optional() });

export function encodeCursor(v: unknown): string {
  return Buffer.from(JSON.stringify(v)).toString("base64url");
}

export function decodeCursor<T>(s: string | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}
