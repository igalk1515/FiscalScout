// Crawl from the command line and print a summary.
// Usage:
//   npm run crawl -- https://www.a2gov.org/ [--depth 3] [--budget 300]
//   npm run crawl:test-sites            (the four test sites, in parallel)
// If the API is running, each crawl can be watched at http://localhost:3000/live/<id>.
import { createContext, startCrawl } from "../app.js";
import { TEST_SITES } from "./test-sites.js";

const args = process.argv.slice(2);
const flag = (name: string, fallback: number) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const depth = flag("--depth", 3);
const budget = flag("--budget", 300);
const seeds = args.includes("--test-sites") ? TEST_SITES.map((s) => s.seed) : args.filter((a) => /^https?:\/\//.test(a));
if (!seeds.length) {
  console.error("usage: npm run crawl -- <url> [--depth N] [--budget N]   or   npm run crawl:test-sites");
  process.exit(1);
}

const ctx = await createContext({ log: { info: () => {}, warn: (o, m) => console.warn(m ?? "", o), error: (o, m) => console.error(m ?? "", o) } });
const port = ctx.config.PORT;
console.log(`LLM: ${ctx.llm.enabled ? ctx.llm.model : "off (no OPENAI_API_KEY): rules only"}`);

const crawls = await Promise.all(seeds.map((url) => startCrawl(ctx, { url, maxDepth: depth, pageBudget: budget })));
for (const { crawl } of crawls) {
  console.log(`started ${crawl.seed_url}  ->  http://localhost:${port}/live/${crawl.id}`);
  let pages = 0;
  ctx.events.subscribe(crawl.id, (e) => {
    const host = new URL(crawl.seed_url).host;
    if (e.type === "page.fetched" && ++pages % 25 === 0) console.log(`  ${host}: ${pages} pages`);
    if (e.type === "link.found" && Number(e.data.score) >= 0.7) console.log(`  ${host}: ★ ${e.data.doc_type} ${e.data.fiscal_year ?? ""} ${e.data.url}`);
    if (e.type === "contact.found") console.log(`  ${host}: ★ contact ${e.data.name} · ${e.data.title ?? ""}`);
    if (e.type.startsWith("crawl.") && e.type !== "crawl.started") console.log(`  ${host}: ${e.type} ${e.data.detail ?? ""}`);
  });
}
await Promise.all(crawls.map(({ crawl }) => ctx.runner.start(crawl.id)));

console.log("\n================ summary ================");
for (const { crawl } of crawls) {
  const c = (await ctx.db.query("select * from crawls where id = $1", [crawl.id])).rows[0];
  console.log(`\n${c.seed_url}\n  status: ${c.status}${c.status_detail ? ` (${c.status_detail})` : ""} · pages fetched: ${c.pages_fetched}`);
  const top = await ctx.db.query(
    `select * from (
       select s.doc_type, s.target_score, l.fiscal_year, l.url, coalesce(l.label, '') as label,
              row_number() over (partition by s.doc_type order by s.target_score desc, coalesce(l.fiscal_year, 0) desc) as n
       from link_scores s join links l on l.id = s.link_id
       where s.crawl_id = $1 and s.doc_type is not null and l.type = 'document'
     ) t where n <= 3 order by doc_type, n`,
    [crawl.id],
  );
  for (const r of top.rows) console.log(`  ${r.target_score.toFixed(2)}  ${r.doc_type.padEnd(16)} ${String(r.fiscal_year ?? "").padEnd(4)}  ${r.label.slice(0, 50)}\n        ${r.url}`);
  const people = await ctx.db.query("select name, title, email, score from contacts where crawl_id = $1 order by score desc limit 3", [crawl.id]);
  for (const p of people.rows) console.log(`  ${p.score.toFixed(2)}  contact          ${p.name} · ${p.title ?? ""} · ${p.email ?? "no email"}`);
}
await ctx.close();
