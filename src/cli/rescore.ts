// Rank a finished crawl again from the saved raw pages, without fetching anything.
// Usage:
//   npm run rescore -- <crawl-id>
//   npm run rescore -- --test-sites     (the latest crawl of each test site)
//   add --llm to run the LLM tier too (cached answers are free)
import { createContext } from "../app.js";
import { rescoreCrawl } from "../crawler/rescore.js";
import { hostOf, normalizeUrl, registrableDomain } from "../crawler/url.js";
import * as repo from "../store/repo.js";
import { TEST_SITES } from "./test-sites.js";

const ctx = await createContext({ log: { info: () => {}, warn: () => {}, error: (o) => console.error(o) } });
const ids: string[] = [];
if (process.argv.includes("--test-sites")) {
  for (const s of TEST_SITES) {
    const c = await repo.latestCrawlForDomain(ctx.db, registrableDomain(hostOf(normalizeUrl(s.seed)!)));
    if (c && c.status === "done") ids.push(c.id);
  }
} else {
  ids.push(...process.argv.slice(2).filter((a) => /^[0-9a-f-]{36}$/.test(a)));
}
if (!ids.length) {
  console.error("usage: npm run rescore -- <crawl-id> | --test-sites");
  process.exit(1);
}
for (const id of ids) {
  const t0 = Date.now();
  const r = await rescoreCrawl(ctx, id, { llm: process.argv.includes("--llm") && ctx.llm.enabled });
  const c = await repo.getCrawl(ctx.db, id);
  console.log(`${c!.seed_url}: ${r.pages} pages re-ranked from disk in ${Date.now() - t0} ms, ${r.links} links, ${r.contacts} contacts${r.missing ? `, ${r.missing} raw files missing` : ""}`);
}
await ctx.close();
