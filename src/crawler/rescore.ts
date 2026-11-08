import type { AppContext } from "../app.js";
import { findContacts } from "../ranking/contacts.js";
import { compileKeywords, type KeywordConfig } from "../ranking/keywords.js";
import { RANKER_VERSION, scoreLink } from "../ranking/rules.js";
import * as repo from "../store/repo.js";
import { extractPage, parseHtml } from "./extract.js";
import { readRaw } from "./rawstore.js";
import { hostOf, inScope, urlHash } from "./url.js";

/**
 * Ranks a finished crawl again from the raw pages saved on disk, without fetching anything:
 * after a change to the rules, or with a different keyword set. Rules only.
 * The raw file of a URL is its latest fetch, which may come from a later crawl.
 */
export async function rescoreCrawl(ctx: AppContext, crawlId: string, keywords?: KeywordConfig) {
  const crawl = await repo.getCrawl(ctx.db, crawlId);
  if (!crawl) throw new Error(`crawl ${crawlId} not found`);
  const groups = compileKeywords(keywords ?? crawl.keywords);
  const scope = { domain: crawl.scope_domain, extraHosts: new Set(crawl.extra_hosts) };
  const pages = await ctx.db.query<{ id: number; url: string; final_url: string | null; raw_path: string; path_score: number; depth: number }>(
    `select p.id, p.url, p.final_url, p.raw_path, f.path_score, f.depth
     from frontier f join pages p on p.url_hash = f.url_hash
     where f.crawl_id = $1 and f.status = 'done' and p.raw_path is not null
     order by f.depth, f.path_score desc`,
    [crawlId],
  );
  await ctx.db.query("delete from link_scores where crawl_id = $1", [crawlId]);
  await ctx.db.query("delete from sightings where crawl_id = $1", [crawlId]);
  await ctx.db.query("delete from contacts where crawl_id = $1", [crawlId]);

  let links = 0;
  let contacts = 0;
  let missing = 0;
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
    const page = extractPage($, pageUrl);
    const scored = page.links
      .map((link) => ({ link, s: scoreLink(link, { groups, parentPathScore: p.path_score, internal: inScope(link.url, scope) }) }))
      .filter((x) => x.s.targetScore > 0);
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
        decidedBy: "rules",
        anchor: link.anchor,
        heading: link.heading,
        context: link.context,
        boilerplate: link.boilerplate,
      })),
    );
    links += saved.filter((x) => x.isNew).length;
    const people = await findContacts($, page.dataBlocks, { groups, entityDomain: scope.domain, pagePathScore: p.path_score });
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
  return { pages: pages.rows.length, links, contacts, missing };
}
