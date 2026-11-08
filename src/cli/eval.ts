// Step 11: measure the crawler against the must-find list of the test sites.
// Usage:
//   npm run eval            uses the latest crawl of each test site
//   npm run eval -- --run   crawls the four sites first (several minutes)
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
out(`LLM tier: ${ctx.llm.enabled ? ctx.llm.model : "off (no OPENAI_API_KEY), rules only"}`);
out("");
out("| Site | Crawl | Must-find | Precision@10 (documents) |");
out("|---|---|---|---|");

const details: string[] = [];
let found = 0;
let total = 0;
for (const site of spec.sites) {
  const seedHost = hostOf(normalizeUrl(site.seed)!);
  const crawl = await repo.latestCrawlForDomain(ctx.db, registrableDomain(seedHost));
  if (!crawl) {
    out(`| ${site.name} | no crawl yet | - | - |`);
    continue;
  }
  const crawlText = `${crawl.status}, ${crawl.pages_fetched} pages`;
  if (site.expect_blocked) {
    const ok = crawl.status === "blocked";
    out(`| ${site.name} | ${crawlText} | ${ok ? "blocked and reported, as expected" : "expected a blocked report"} | - |`);
    details.push(`\n## ${site.name}\n\n- ${crawl.status_detail ?? crawl.status}`);
    continue;
  }

  const docs = await ctx.db.query<{ url: string; label: string | null; doc_type: string | null; target_score: number; fiscal_year: number | null }>(
    `select l.url, l.label, s.doc_type, s.target_score, l.fiscal_year
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
  const precise = top10.filter((d) => relevant.test(`${d.url} ${d.label ?? ""}`)).length;
  out(`| ${site.name} | ${crawlText} | ${siteFound}/${site.expect.length} | ${top10.length ? `${precise}/${top10.length}` : "-"} |`);
  siteDetails.push("", "Top 5 documents:");
  for (const d of docs.rows.slice(0, 5)) {
    siteDetails.push(`- ${d.target_score.toFixed(2)} ${d.doc_type ?? "-"} ${d.fiscal_year ?? ""} ${d.label ?? ""} <${d.url}>`);
  }
  details.push(siteDetails.join("\n"));
}
out("");
out(`**Must-find recall: ${found}/${total}**`);
out("");
out(
  "Precision@10 counts how many of the ten best-scored documents match a hand-written pattern for finance documents (ACFR, budget, audit, financial report). It is a quick check, not a full labeled set.",
);
for (const d of details) out(d);

await writeFile(resolve(root, "eval/results.md"), `${lines.join("\n")}\n`);
console.log("\nwritten to eval/results.md");
await ctx.close();
