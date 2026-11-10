// Rank a finished crawl again from the saved raw pages, without fetching anything.
// Usage:
//   npm run rescore -- <crawl-id>
//   npm run rescore -- --test-sites     (the latest crawl of each test site)
//   add --llm to run the LLM tier too (cached answers are free)
//   add --ranker learned|rules to switch the crawls to that ranker
import { createContext } from "../app.js";
import { rescoreCrawl } from "../crawler/rescore.js";
import { hostOf, normalizeUrl, registrableDomain } from "../crawler/url.js";
import { RANKER_NAMES, type RankerName } from "../ranking/rank.js";
import * as repo from "../store/repo.js";
import { TEST_SITES } from "./test-sites.js";

const rIdx = process.argv.indexOf("--ranker");
const ranker = rIdx > 0 ? (process.argv[rIdx + 1] as RankerName) : undefined;
if (ranker && !RANKER_NAMES.includes(ranker)) {
  console.error(`--ranker must be one of ${RANKER_NAMES.join(", ")}`);
  process.exit(1);
}
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
  const r = await rescoreCrawl(ctx, id, { llm: process.argv.includes("--llm") && ctx.llm.enabled, ranker });
  const c = await repo.getCrawl(ctx.db, id);
  console.log(`${c!.seed_url}: ${r.pages} pages re-ranked from disk in ${Date.now() - t0} ms, ${r.links} links, ${r.contacts} contacts, ranker ${r.ranker}${r.missing ? `, ${r.missing} raw files missing` : ""}`);
}
await ctx.close();
