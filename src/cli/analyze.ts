// Analyze one page without a database: ranked links and contacts, with the reason for each score.
// Usage:
//   npm run analyze -- https://www.a2gov.org/finance-and-administrative-services/financial-reporting/
//   npm run analyze -- path/to/saved.html --url https://original/url   (offline)
import { readFileSync } from "node:fs";
import { config, robotsToken, userAgent } from "../config.js";
import { extractPage, parseHtml } from "../crawler/extract.js";
import { fetchUrl } from "../crawler/fetcher.js";
import { fetchRobots, isAllowed } from "../crawler/robots.js";
import { inScope, registrableDomain } from "../crawler/url.js";
import { findContacts } from "../ranking/contacts.js";
import { compileKeywords, DEFAULT_KEYWORDS } from "../ranking/keywords.js";
import { createLlm, memoryCache } from "../ranking/llm.js";
import { scoreLink } from "../ranking/rules.js";
import { applyLlmTier } from "../ranking/tier.js";

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--"));
const urlFlag = args.indexOf("--url");
const top = Number(args[args.indexOf("--top") + 1]) || 15;
if (!target) {
  console.error("usage: npm run analyze -- <url | file.html --url original-url> [--top N]");
  process.exit(1);
}

let html: string;
let pageUrl: string;
if (/^https?:\/\//.test(target)) {
  const robots = await fetchRobots(target, userAgent);
  if (!isAllowed(robots.policy, target, robotsToken)) {
    console.error("robots.txt disallows this URL");
    process.exit(2);
  }
  const r = await fetchUrl(target, { userAgent });
  if (!r.body) {
    console.error(`no HTML: status ${r.status} ${r.error ?? ""}`);
    process.exit(3);
  }
  html = r.body.toString("utf8");
  pageUrl = r.finalUrl;
} else {
  html = readFileSync(target, "utf8");
  pageUrl = urlFlag >= 0 ? args[urlFlag + 1]! : "https://example.invalid/";
}

const $ = parseHtml(html);
const page = extractPage($, pageUrl);
const groups = compileKeywords(DEFAULT_KEYWORDS);
const scope = { domain: registrableDomain(new URL(pageUrl).hostname), extraHosts: new Set<string>() };
const scored = page.links.map((l) => ({
  link: l,
  s: scoreLink(l, { groups, parentPathScore: 0.9, internal: inScope(l.url, scope) }),
}));
// With a key, unsure links go to the LLM, exactly as in a crawl.
const llm = createLlm({ apiKey: config.OPENAI_API_KEY, model: config.OPENAI_MODEL, baseUrl: config.OPENAI_BASE_URL, cache: memoryCache(), onError: (m) => console.warn(m) });
let calls = 0;
let cost = 0;
const onCall = (c: { cached: boolean; costUsd: number }) => {
  calls += c.cached ? 0 : 1;
  cost += c.costUsd;
};
const decided = await applyLlmTier(llm, groups, scored, onCall);

console.log(`${page.title}\n${pageUrl}`);
console.log(`${page.links.length} links, ${page.visibleTextLength} characters of text${page.thin ? ", THIN (needs a browser)" : ""}\n`);
console.log(`Top ${top} by target score (is it a result?)`);
for (const { link, s } of [...scored].sort((a, b) => b.s.targetScore - a.s.targetScore).slice(0, top)) {
  if (s.targetScore <= 0) break;
  console.log(`  ${s.targetScore.toFixed(2)}  ${(s.docType ?? "-").padEnd(16)} ${String(s.fiscalYear ?? "").padEnd(4)} ${link.anchor.slice(0, 50)}`);
  console.log(`        ${link.url}`);
  console.log(`        ${s.reason}`);
}
console.log(`\nTop ${Math.min(top, 10)} by path score (does it lead to results?)`);
for (const { link, s } of [...scored].sort((a, b) => b.s.pathScore - a.s.pathScore).slice(0, Math.min(top, 10))) {
  console.log(`  ${s.pathScore.toFixed(2)}  ${link.anchor.slice(0, 40).padEnd(40)} ${link.url}`);
}
const contacts = await findContacts($, page.dataBlocks, {
  groups,
  entityDomain: scope.domain,
  pagePathScore: 0.9,
  llm,
  onLlmCall: onCall,
});
console.log(`\nContacts${llm.enabled ? "" : " (rules only, no LLM key)"}`);
for (const c of contacts) {
  console.log(`  ${c.score.toFixed(2)}  ${c.name} | ${c.title ?? "-"} | ${c.email ?? "-"} | ${c.phone ?? "-"}  [${c.decidedBy}]`);
}
if (!contacts.length) console.log("  none");
console.log(llm.enabled ? `\nLLM: ${llm.model}, ${decided} links decided, ${calls} calls, $${cost.toFixed(4)}` : "\nLLM: off (no OPENAI_API_KEY)");
