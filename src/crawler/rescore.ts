import type { AppContext } from "../app.js";
import { findContacts } from "../ranking/contacts.js";
import { compileKeywords, type KeywordConfig } from "../ranking/keywords.js";
import { RANKER_VERSION, scoreLink } from "../ranking/rules.js";
import { applyLlmTier } from "../ranking/tier.js";
import * as repo from "../store/repo.js";
import { extractPage, type LinkCandidate, parseHtml } from "./extract.js";
import { readRaw } from "./rawstore.js";
import { hostOf, inScope, mirrorOf, unmirror, urlHash } from "./url.js";

/**
 * Ranks a finished crawl again from the raw pages saved on disk, without fetching anything:
 * after a change to the rules, or with a different keyword set. With llm, the LLM tier runs too.
 * The raw file of a URL is its latest fetch, which may come from a later crawl.
 */
export async function rescoreCrawl(ctx: AppContext, crawlId: string, opts: { keywords?: KeywordConfig; llm?: boolean } = {}) {
  const { keywords } = opts;
  const llm = opts.llm ? ctx.llm : null;
  const crawl = await repo.getCrawl(ctx.db, crawlId);
  if (!crawl) throw new Error(`crawl ${crawlId} not found`);
  const groups = compileKeywords(keywords ?? crawl.keywords);
  const scope = { domain: crawl.scope_domain, extraHosts: new Set(crawl.extra_hosts) };
  // Pages the crawl read as copies of a page already read ("same content", "same page as") were
  // not ranked during the crawl, so they are not ranked here either.
  const pages = await ctx.db.query<{ id: number; url: string; final_url: string | null; raw_path: string; path_score: number; depth: number }>(
    `select p.id, p.url, p.final_url, p.raw_path, f.path_score, f.depth
     from frontier f join pages p on p.url_hash = f.url_hash
     where f.crawl_id = $1 and f.status = 'done' and p.raw_path is not null and coalesce(f.reason, '') not like 'same %'
     order by f.depth, f.path_score desc`,
    [crawlId],
  );
  // What the crawl learned by fetching: an opaque URL (".../DocumentCenter/View/77") that turned
  // out to be a PDF is still a PDF when ranked again.
  const learned = await ctx.db.query<{ url: string; file_type: string | null }>(
    `select l.url, l.file_type from links l join link_scores s on s.link_id = l.id
     where s.crawl_id = $1 and l.type = 'document' and l.file_type is not null`,
    [crawlId],
  );
  const fileTypes = new Map(learned.rows.map((r) => [r.url, r.file_type!]));
  await ctx.db.query("delete from link_scores where crawl_id = $1", [crawlId]);
  await ctx.db.query("delete from sightings where crawl_id = $1", [crawlId]);
  await ctx.db.query("delete from contacts where crawl_id = $1", [crawlId]);

  let missing = 0;
  const read: { p: (typeof pages.rows)[number]; pageUrl: string; $: ReturnType<typeof parseHtml>; page: ReturnType<typeof extractPage> }[] = [];
  for (const p of pages.rows) {
    let html: string;
    try {
      html = await readRaw(ctx.config.RAW_DIR, p.raw_path);
    } catch {
      missing++;
      continue;
    }
    const pageUrl = p.final_url ?? p.url;
    const $ = parseHtml(html);
    read.push({ p, pageUrl, $, page: extractPage($, pageUrl) });
  }
  // Mirror hosts, learned from canonical links as during the crawl: their links count under the
  // original host.
  const mirrors = new Map<string, string>();
  for (const { pageUrl, page } of read) {
    const m = mirrorOf(pageUrl, page.canonical, scope);
    if (m && !mirrors.has(m.host)) mirrors.set(m.host, m.origin);
  }

  let links = 0;
  let contacts = 0;
  for (const { p, pageUrl: fetchedUrl, $, page } of read) {
    const pageUrl = mirrorOf(fetchedUrl, page.canonical, scope) ? page.canonical! : fetchedUrl;
    if (mirrors.size) {
      const byUrl = new Map<string, LinkCandidate>();
      for (const l of page.links) {
        const url = unmirror(l.url, mirrors);
        const prev = byUrl.get(url);
        if (!prev || (prev.boilerplate && !l.boilerplate)) byUrl.set(url, { ...l, url });
      }
      page.links = [...byUrl.values()];
    }
    const all = page.links.map((link) => ({
      link,
      s: scoreLink(link, { groups, parentPathScore: p.path_score, internal: inScope(link.url, scope), contentTypeFileType: fileTypes.get(link.url) }),
    }));
    if (llm) await applyLlmTier(llm, groups, all); // answers seen before come from the cache, free
    const scored = all.filter((x) => x.s.targetScore > 0);
    const saved = await repo.saveLinks(
      ctx.db,
      crawlId,
      p.id,
      p.depth,
      RANKER_VERSION,
      scored.map(({ link, s }) => ({
        hash: urlHash(link.url),
        url: link.url,
        host: hostOf(link.url),
        label: link.anchor || link.titleAttr,
        type: s.type,
        fileType: s.fileType,
        fiscalYear: s.fiscalYear,
        isDraft: s.isDraft,
        docType: s.docType,
        targetScore: s.targetScore,
        pathScore: s.pathScore,
        matchedKeywords: s.matchedKeywords,
        reason: s.reason,
        decidedBy: s.decidedBy ?? "rules",
        anchor: link.anchor,
        heading: link.heading,
        context: link.context,
        boilerplate: link.boilerplate,
      })),
    );
    links += saved.filter((x) => x.isNew).length;
    const people = await findContacts($, page.dataBlocks, { groups, entityDomain: scope.domain, pagePathScore: p.path_score, llm });
    if (people.length) {
      const fresh = await repo.saveContacts(
        ctx.db,
        crawlId,
        people.map((c) => ({
          host: hostOf(pageUrl),
          name: c.name,
          title: c.title,
          email: c.email,
          phone: c.phone,
          score: c.score,
          matchedKeywords: c.matchedKeywords,
          sourcePageId: p.id,
          sourceUrl: pageUrl,
          snippet: c.snippet,
          decidedBy: c.decidedBy,
        })),
      );
      contacts += fresh.length;
    }
  }
  return { pages: pages.rows.length, links, contacts, missing, mirrors: [...mirrors.keys()] };
}
