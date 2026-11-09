// Step 11: measure the crawler against the must-find list of the test sites.
// Usage:
//   npm run eval            uses the latest crawl of each test site
//   npm run eval -- --run   crawls the four sites first (several minutes)
//   add --out <file> to write somewhere other than eval/results.md
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, startCrawl } from "../app.js";
import { hostOf, normalizeUrl, registrableDomain } from "../crawler/url.js";
import * as repo from "../store/repo.js";

interface Expect {
  kind: "document" | "contact";
  what: string;
  doc_type?: string;
  any_of?: string[];
  name?: string;
  email?: string;
}
interface Site {
  name: string;
  seed: string;
  domain: string;
  expect: Expect[];
  expect_blocked?: boolean;
  /** Hosts whose documents belong to someone else (another government): never a hit. */
  not_entity_hosts?: string[];
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const spec = JSON.parse(await readFile(resolve(root, "eval/must-find.json"), "utf8")) as { sites: Site[]; relevant_pattern: string };
const relevant = new RegExp(spec.relevant_pattern, "i");
const ctx = await createContext({ log: { info: () => {}, warn: () => {}, error: (o) => console.error(o) } });

if (process.argv.includes("--run")) {
  console.log("crawling the test sites first...");
  const started = await Promise.all(spec.sites.map((s) => startCrawl(ctx, { url: s.seed, maxDepth: 3, pageBudget: 300 })));
  await Promise.all(started.map(({ crawl }) => ctx.runner.start(crawl.id)));
}

const lines: string[] = [];
const out = (s = "") => {
  console.log(s);
  lines.push(s);
};
out(`# Evaluation · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`);
out("");
if (process.argv.includes("--run")) {
  out(`Crawled for this report: depth 3, page budget 300, LLM ${ctx.llm.enabled ? ctx.llm.model : "off"}, browser rendering ${ctx.config.RENDER_JS ? "on" : "off"}.`);
  out("");
}
out("| Site | Crawl | Must-find | Precision@10 (documents) | Links decided by the LLM |");
out("|---|---|---|---|---|");

const details: string[] = [];
let found = 0;
let total = 0;
for (const site of spec.sites) {
  // The latest finished crawl of the site's domain (from www.boerneisd.net or boerneisd.net
  // alike), at depth 1 or more.
  const latest = await ctx.db.query<repo.CrawlRow>(
    `select * from crawls where scope_domain = $1 and max_depth >= 1 and status in ('done', 'blocked', 'failed')
     order by created_at desc limit 1`,
    [registrableDomain(hostOf(normalizeUrl(site.seed)!))],
  );
  const crawl = latest.rows[0];
  if (!crawl) {
    out(`| ${site.name} | no crawl yet | - | - | - |`);
    continue;
  }
  const crawlText = `${crawl.status}, ${crawl.pages_fetched} pages (\`${crawl.id.slice(0, 8)}\`)`;
  if (site.expect_blocked) {
    const ok = crawl.status === "blocked";
    out(`| ${site.name} | ${crawlText} | ${ok ? "blocked and reported, as expected" : "expected a blocked report"} | - | - |`);
    details.push(`\n## ${site.name}\n\n- ${crawl.status_detail ?? crawl.status}`);
    continue;
  }

  const docs = await ctx.db.query<{ url: string; host: string; label: string | null; headings: string | null; doc_type: string | null; target_score: number; fiscal_year: number | null }>(
    `select l.url, l.host, l.label, s.doc_type, s.target_score, l.fiscal_year,
       (select string_agg(distinct g.section_heading, ' | ') from sightings g where g.link_id = l.id and g.crawl_id = s.crawl_id) as headings
     from link_scores s join links l on l.id = s.link_id
     where s.crawl_id = $1 and l.type = 'document'
     order by s.target_score desc, coalesce(l.fiscal_year, 0) desc, l.id`,
    [crawl.id],
  );
  const contacts = await ctx.db.query<{ name: string; title: string | null; email: string | null; score: number }>(
    "select name, title, email, score from contacts where crawl_id = $1 order by score desc",
    [crawl.id],
  );

  const siteDetails = [`\n## ${site.name}\n`];
  let siteFound = 0;
  for (const e of site.expect) {
    total++;
    let ok = false;
    let note = "";
    if (e.kind === "document") {
      const ofType = docs.rows.filter((d) => d.doc_type === e.doc_type);
      const rank = ofType.findIndex((d) => e.any_of!.includes(d.url));
      ok = rank >= 0 && rank < 10;
      note = rank >= 0 ? `rank ${rank + 1} of ${ofType.length} ${e.doc_type} documents, score ${ofType[rank]!.target_score.toFixed(2)}` : "not found";
    } else {
      const c = contacts.rows.find((x) => x.name === e.name);
      ok = !!c && (!e.email || c.email === e.email);
      note = c ? `${c.name} · ${c.title ?? "-"} · ${c.email ?? "no email"} · score ${c.score.toFixed(2)}` : "not found";
    }
    if (ok) siteFound++;
    siteDetails.push(`- ${ok ? "found" : "MISSED"}: ${e.what} (${note})`);
  }
  found += siteFound;
  const top10 = docs.rows.slice(0, 10);
  // A hit names a finance document in its text, URL or heading, and is the entity's own.
  const notEntity = new Set(site.not_entity_hosts ?? []);
  const isHit = (d: (typeof top10)[number]) => relevant.test(`${d.url} ${d.label ?? ""} ${d.headings ?? ""}`) && !notEntity.has(d.host);
  const precise = top10.filter(isHit).length;
  const by = await ctx.db.query<{ llm: number; total: number }>(
    "select count(*) filter (where decided_by = 'llm')::int as llm, count(*)::int as total from link_scores where crawl_id = $1",
    [crawl.id],
  );
  const decided = `${by.rows[0]!.llm} of ${by.rows[0]!.total}`;
  out(`| ${site.name} | ${crawlText} | ${siteFound}/${site.expect.length} | ${top10.length ? `${precise}/${top10.length}` : "-"} | ${decided} |`);
  siteDetails.push("", "Top 5 documents:");
  for (const d of docs.rows.slice(0, 5)) {
    siteDetails.push(`- ${d.target_score.toFixed(2)} ${d.doc_type ?? "-"} ${d.fiscal_year ?? ""} ${d.label ?? ""} <${d.url}>${notEntity.has(d.host) ? " (not the entity's)" : ""}`);
  }
  details.push(siteDetails.join("\n"));
}
out("");
out(`**Must-find recall: ${found}/${total}**`);
out("");
out(
  "Precision@10 counts how many of the ten best-scored documents name a finance document (ACFR, budget, audit, financial report) in their link text, URL or the heading they sit under, and belong to the entity: documents on hosts listed as someone else's (the State of Arizona's budget office for ASU) never count. It is a quick check, not a full labeled set.",
);
for (const d of details) out(d);

const outIdx = process.argv.indexOf("--out");
const outFile = outIdx > 0 && process.argv[outIdx + 1] ? process.argv[outIdx + 1]! : "eval/results.md";
await writeFile(resolve(root, outFile), `${lines.join("\n")}\n`);
console.log(`\nwritten to ${outFile}`);
await ctx.close();
