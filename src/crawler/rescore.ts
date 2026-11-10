import type { AppContext } from "../app.js";
import { findContacts } from "../ranking/contacts.js";
import { compileKeywords, type KeywordConfig } from "../ranking/keywords.js";
import { type RankerName, rankerName, rankerVersion, rankLink } from "../ranking/rank.js";
import { applyLlmTier } from "../ranking/tier.js";
import * as repo from "../store/repo.js";
import { extractPage, type LinkCandidate, parseHtml } from "./extract.js";
import { readRaw } from "./rawstore.js";
import { hostOf, inScope, mirrorOf, unmirror, urlHash } from "./url.js";

export interface SavedPage {
  p: { id: number; url: string; final_url: string | null; raw_path: string; path_score: number; depth: number };
  /** The page's URL, with a mirror host mapped back to the original. */
  pageUrl: string;
  $: ReturnType<typeof parseHtml>;
  page: ReturnType<typeof extractPage>;
}

/**
 * The pages a finished crawl ranked, read back from the raw files on disk, with their links
 * as the crawl saw them (mirror hosts mapped back to the original host). Shared by re-ranking
 * and by the learned ranker's dataset builder.
 *
 * Pages are read one at a time, so memory stays flat on a crawl of thousands of pages. Mirror
 * hosts come first, from a quick pass over each page's head, because every page's links need
 * the full list.
 */
export async function readSavedPages(ctx: AppContext, crawl: repo.CrawlRow) {
  const crawlId = crawl.id;
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

  // Mirror hosts, learned from canonical links as during the crawl: their links count under the
  // original host. Only the head of each page is parsed for this.
  const mirrors = new Map<string, string>();
  for (const p of pages.rows) {
    let html: string;
    try {
      html = await readRaw(ctx.config.RAW_DIR, p.raw_path);
    } catch {
      continue;
    }
    const headEnd = html.search(/<\/head\s*>/i);
    const head = headEnd > 0 ? html.slice(0, headEnd) : html.slice(0, 65536);
    const pageUrl = p.final_url ?? p.url;
    const m = mirrorOf(pageUrl, extractPage(head, pageUrl).canonical, scope);
    if (m && !mirrors.has(m.host)) mirrors.set(m.host, m.origin);
  }

  const counts = { missing: 0 };
  async function* each(): AsyncGenerator<SavedPage> {
    for (const p of pages.rows) {
      let html: string;
      try {
        html = await readRaw(ctx.config.RAW_DIR, p.raw_path);
      } catch {
        counts.missing++;
        continue;
      }
      let pageUrl = p.final_url ?? p.url;
      const $ = parseHtml(html);
      const page = extractPage($, pageUrl);
      if (mirrorOf(pageUrl, page.canonical, scope)) pageUrl = page.canonical!;
      if (mirrors.size) {
        const byUrl = new Map<string, LinkCandidate>();
        for (const l of page.links) {
          const url = unmirror(l.url, mirrors);
          const prev = byUrl.get(url);
          if (!prev || (prev.boilerplate && !l.boilerplate)) byUrl.set(url, { ...l, url });
        }
        page.links = [...byUrl.values()];
      }
      yield { p, pageUrl, $, page };
    }
  }
  return { each, total: pages.rows.length, counts, mirrors, fileTypes, scope };
}

/**
 * Ranks a finished crawl again from the raw pages saved on disk, without fetching anything:
 * after a change to the rules, with a different keyword set, or with the other ranker. With
 * llm, the LLM tier runs too. The raw file of a URL is its latest fetch, which may come from a
 * later crawl.
 */
export async function rescoreCrawl(
  ctx: AppContext,
  crawlId: string,
  opts: { keywords?: KeywordConfig; llm?: boolean; ranker?: RankerName } = {},
) {
  const { keywords } = opts;
  const llm = opts.llm ? ctx.llm : null;
  const crawl = await repo.getCrawl(ctx.db, crawlId);
  if (!crawl) throw new Error(`crawl ${crawlId} not found`);
  const groups = compileKeywords(keywords ?? crawl.keywords);
  const version = opts.ranker ? rankerVersion(opts.ranker) : crawl.ranker_version;
  const { each, total, counts, mirrors, fileTypes, scope } = await readSavedPages(ctx, crawl);
  await ctx.db.query("delete from link_scores where crawl_id = $1", [crawlId]);
  await ctx.db.query("delete from sightings where crawl_id = $1", [crawlId]);
  await ctx.db.query("delete from contacts where crawl_id = $1", [crawlId]);
  if (version !== crawl.ranker_version) await ctx.db.query("update crawls set ranker_version = $2 where id = $1", [crawlId, version]);

  let links = 0;
  let contacts = 0;
  for await (const { p, pageUrl, $, page } of each()) {
    const all = page.links.map((link) => ({
      link,
      s: rankLink(link, { groups, parentPathScore: p.path_score, internal: inScope(link.url, scope), contentTypeFileType: fileTypes.get(link.url) }, version),
    }));
    if (llm) await applyLlmTier(llm, groups, all); // answers seen before come from the cache, free
    const scored = all.filter((x) => x.s.targetScore > 0);
    const saved = await repo.saveLinks(
      ctx.db,
      crawlId,
      p.id,
      p.depth,
      version,
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
  return { pages: total, links, contacts, missing: counts.missing, mirrors: [...mirrors.keys()], ranker: rankerName(version) };
}
