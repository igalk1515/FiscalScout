// The learned ranker: build a dataset of links, label it, fit the weights, measure.
//
//   npm run learn -- dataset         links with a keyword signal, from the latest crawl of every
//                                    site, read back from the raw pages (eval/learn/links.jsonl)
//   npm run learn -- label           the LLM labels links that have no label yet
//                                    (eval/learn/labels.jsonl; answers cached; prints the cost)
//   npm run learn -- train           leave-one-site-out evaluation against the rules, then the
//                                    final fit on every site (src/ranking/learned-weights.ts and
//                                    eval/results-learned.md)
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { type AppContext, createContext } from "../app.js";
import type { LinkCandidate } from "../crawler/extract.js";
import { readSavedPages } from "../crawler/rescore.js";
import { inScope } from "../crawler/url.js";
import { compileKeywords, DEFAULT_KEYWORDS } from "../ranking/keywords.js";
import { FEATURES, type FeatureName, groupFeatures, type LearnedModel, scoreLinkLearned, toVector } from "../ranking/learned.js";
import { auc, trainLogistic } from "../ranking/logistic.js";
import { scoreLink } from "../ranking/rules.js";
import * as repo from "../store/repo.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DIR = resolve(root, "eval/learn");
const LINKS = resolve(DIR, "links.jsonl");
const LABELS = resolve(DIR, "labels.jsonl");
const groups = compileKeywords(DEFAULT_KEYWORDS);
// The ranking date for every evaluation, so the results do not drift with the calendar.
const NOW = new Date("2026-11-09T00:00:00Z");

/** One link as found on one page: everything the rankers read, nothing they compute. */
interface Sample {
  id: string;
  site: string;
  url: string;
  anchor: string;
  titleAttr: string;
  heading: string;
  context: string;
  boilerplate: boolean;
  internal: boolean;
  parentPathScore: number;
  fileType: string | null;
}
interface Label {
  id: string;
  is_target: boolean;
  target: string | null;
  reason: string;
}

const readJsonl = async <T>(file: string): Promise<T[]> =>
  existsSync(file) ? (await readFile(file, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as T) : [];

const candidate = (s: Sample): LinkCandidate => ({
  url: s.url,
  anchor: s.anchor,
  titleAttr: s.titleAttr,
  heading: s.heading,
  context: s.context,
  boilerplate: s.boilerplate,
  nofollow: false,
  source: "html",
});
const scoreCtx = (s: Sample) => ({ groups, parentPathScore: s.parentPathScore, internal: s.internal, contentTypeFileType: s.fileType, now: NOW });

// ---------------------------------------------------------------- dataset

async function buildDataset(ctx: AppContext) {
  // The latest finished crawl of each site with at least 20 pages.
  const crawls = await ctx.db.query<repo.CrawlRow>(
    `select distinct on (scope_domain) * from crawls
     where status = 'done' and pages_fetched >= 20 and max_depth >= 1
     order by scope_domain, created_at desc`,
  );
  const out: Sample[] = [];
  const seen = new Map<string, number>();
  for (const crawl of crawls.rows) {
    const { pages, fileTypes, scope } = await readSavedPages(ctx, crawl);
    let n = 0;
    for (const { p, page } of pages) {
      for (const link of page.links) {
        const internal = inScope(link.url, scope);
        const ctxS = { groups, parentPathScore: p.path_score, internal, contentTypeFileType: fileTypes.get(link.url) ?? null, now: NOW };
        const base = scoreLink(link, ctxS);
        if (base.noise) continue;
        if (!groups.some((g) => groupFeatures(link, ctxS, g, base))) continue;
        // One sample per link and link text on a site: the same menu link on 300 pages is one.
        // A sighting in the page body beats one in a menu, whose heading is just the nearest one.
        const id = createHash("sha1").update(`${crawl.scope_domain}\n${link.url}\n${link.anchor}`).digest("hex").slice(0, 16);
        const prev = seen.get(id);
        if (prev !== undefined && !(out[prev]!.boilerplate && !link.boilerplate)) continue;
        const sample: Sample = {
          id,
          site: crawl.scope_domain,
          url: link.url,
          anchor: link.anchor,
          titleAttr: link.titleAttr,
          heading: link.heading,
          context: link.context.slice(0, 240),
          boilerplate: link.boilerplate,
          internal,
          parentPathScore: Math.round(p.path_score * 1000) / 1000,
          fileType: fileTypes.get(link.url) ?? null,
        };
        if (prev !== undefined) {
          out[prev] = sample;
        } else {
          seen.set(id, out.length);
          out.push(sample);
          n++;
        }
      }
    }
    console.log(`${crawl.scope_domain.padEnd(24)} ${String(pages.length).padStart(4)} pages  ${String(n).padStart(5)} links`);
  }
  await mkdir(DIR, { recursive: true });
  await writeFile(LINKS, out.map((s) => JSON.stringify(s)).join("\n") + "\n");
  console.log(`\n${out.length} links from ${crawls.rows.length} sites -> eval/learn/links.jsonl`);
}

// ---------------------------------------------------------------- labels

const LABEL_PROMPT_VERSION = "labels-2";
const LabelAnswer = z.object({
  items: z.array(z.object({ i: z.number().int(), is_target: z.boolean(), target: z.string().nullable(), reason: z.string() })),
});
const LABEL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["i", "is_target", "target", "reason"],
        properties: { i: { type: "integer" }, is_target: { type: "boolean" }, target: { type: ["string", "null"] }, reason: { type: "string" } },
      },
    },
  },
};

function labelSystemPrompt() {
  const targets = groups.map((g) => `- "${g.key}" (${g.kind}): ${g.terms.join(", ")}`).join("\n");
  return `You label links for a search tool that finds finance documents and finance contacts of US public bodies: cities, counties, school districts and universities. Each record is one link found on the website of the body named in "site".
The targets are:
${targets}

For each link decide is_target: is the link itself one of the targets, belonging to that body?
The targets are the primary documents themselves, and the people:
- acfr: the annual comprehensive financial report of a fiscal year (also CAFR, annual financial report, audited financial statements).
- budget: the budget document of a fiscal year: the adopted, proposed or recommended budget, the budget book, the operating or capital budget, the capital improvement plan.
- single audit: the single audit report on federal awards.
- finance director: the page about the person who holds a finance leadership title (their profile, or the office page that names them as its head).
Mark true for the document itself (a PDF or file, or a viewer page that shows that one document), also when it is a draft or an older year.
Mark false for everything around the documents:
- answers or responses to questions about the budget, presentations, slides, work-session materials, hearing notices, resolutions, amendments, surveys, summaries, newsletters, press releases;
- a page that lists or links to documents (a hub such as "Budget" or "Financial Reports"), a department home page, news, agendas, minutes, meeting pages;
- degrees and courses, job postings, vendor and bid pages, forms, payment pages;
- any document of another government or organization (the county's, the state's, a housing commission's or another agency's own report).
target: the name of the target from the list above, exactly, or null when is_target is false.
reason: a few words.
Use the link text, the heading above it, the nearby text and the URL. Return one item per link, with the same "i".`;
}

// Labels come from a stronger model than the crawl-time tier: they are the ground truth.
const LABEL_MODEL = process.env.LABEL_MODEL ?? "gpt-4.1-mini";
const PRICES: Record<string, [number, number]> = { "gpt-4o-mini": [0.15, 0.6], "gpt-4.1-mini": [0.4, 1.6], "gpt-4.1": [2, 8], "gpt-4o": [2.5, 10] };

async function label(ctx: AppContext, max: number) {
  const apiKey = ctx.config.OPENAI_API_KEY;
  if (!apiKey) throw new Error("labeling needs OPENAI_API_KEY");
  const samples = await readJsonl<Sample>(LINKS);
  const done = new Set((await readJsonl<Label>(LABELS)).map((l) => l.id));
  const todo = samples.filter((s) => !done.has(s.id)).slice(0, max);
  const system = labelSystemPrompt();
  const keys = new Set(groups.map((g) => g.key));
  let cost = 0;
  let labeled = 0;
  console.log(`${todo.length} links to label (${done.size} already labeled), model ${LABEL_MODEL}`);
  const [priceIn, priceOut] = PRICES[LABEL_MODEL] ?? [2.5, 10];
  for (let i = 0; i < todo.length; i += 40) {
    const batch = todo.slice(i, i + 40);
    const payload = JSON.stringify({
      links: batch.map((s, j) => ({ i: j, site: s.site, url: s.url, text: s.anchor || s.titleAttr, heading: s.heading, nearby: s.context.slice(0, 160) })),
    });
    const key = createHash("sha256").update(`${LABEL_MODEL}\n${LABEL_PROMPT_VERSION}\n${system}\n${payload}`).digest();
    const cached = await ctx.db.query("select response from llm_cache where key = $1", [key]);
    let answer = cached.rows[0] ? LabelAnswer.safeParse(cached.rows[0].response).data : undefined;
    if (!answer) {
      const res = await fetch(`${ctx.config.OPENAI_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: LABEL_MODEL,
          temperature: 0,
          messages: [
            { role: "system", content: system },
            { role: "user", content: payload },
          ],
          response_format: { type: "json_schema", json_schema: { name: "link_labels", strict: true, schema: LABEL_SCHEMA } },
        }),
      });
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as { choices: { message: { content: string } }[]; usage: { prompt_tokens: number; completion_tokens: number } };
      const parsed = LabelAnswer.safeParse(JSON.parse(body.choices[0]!.message.content));
      if (!parsed.success) {
        console.warn(`batch ${i}: answer failed validation, skipped`);
        continue;
      }
      answer = parsed.data;
      cost += (body.usage.prompt_tokens * priceIn + body.usage.completion_tokens * priceOut) / 1_000_000;
      await ctx.db.query(
        "insert into llm_cache (key, model, prompt_version, response) values ($1, $2, $3, $4) on conflict (key) do nothing",
        [key, LABEL_MODEL, LABEL_PROMPT_VERSION, JSON.stringify(answer)],
      );
    }
    const rows: Label[] = [];
    for (const a of answer.items) {
      const s = batch[a.i];
      if (!s) continue;
      const target = a.target && keys.has(a.target) ? a.target : null;
      rows.push({ id: s.id, is_target: a.is_target && !!target, target: a.is_target ? target : null, reason: a.reason });
    }
    if (rows.length) await appendFile(LABELS, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    labeled += rows.length;
    if ((i / 40) % 10 === 0) console.log(`  ${labeled}/${todo.length} labeled, $${cost.toFixed(4)} so far`);
  }
  console.log(`labeled ${labeled} links for $${cost.toFixed(4)} -> eval/learn/labels.jsonl`);
}

// ---------------------------------------------------------------- train and measure

interface Row {
  s: Sample;
  y: number;
  /** Training vectors: the labeled group for a target; every matching group for a non-target. */
  xs: number[][];
  rules: number;
  isDoc: boolean;
}

function rowsFor(samples: Sample[], labels: Map<string, Label>): Row[] {
  const rows: Row[] = [];
  for (const s of samples) {
    const l = labels.get(s.id);
    if (!l) continue;
    const link = candidate(s);
    const ctx = scoreCtx(s);
    const base = scoreLink(link, ctx);
    // A target trains on the features of the group its label names. A non-target must score low
    // for every group (the ranker takes the best group), so each matching group is a negative.
    const feats = groups.map((g) => groupFeatures(link, ctx, g, base)).filter((f) => f !== null);
    if (!feats.length) continue;
    const pick = l.is_target ? [feats.find((f) => f.group.key === l.target) ?? feats[0]!] : feats;
    rows.push({ s, y: l.is_target ? 1 : 0, xs: pick.map((f) => toVector(f.values)), rules: base.targetScore, isDoc: base.type === "document" });
  }
  return rows;
}

/**
 * Fits on rows. Every site counts the same in total, so one site with hundreds of links of one
 * kind (Dane County's 476 department budget requests) cannot set the weights for everyone. A
 * link with several negative vectors counts once.
 */
function fitRows(rows: Row[], l2: number) {
  const perSite = new Map<string, number>();
  for (const r of rows) perSite.set(r.s.site, (perSite.get(r.s.site) ?? 0) + 1);
  const avg = rows.length / perSite.size;
  const X: number[][] = [];
  const y: number[] = [];
  const w: number[] = [];
  for (const r of rows) {
    for (const x of r.xs) {
      X.push(x);
      y.push(r.y);
      w.push(avg / perSite.get(r.s.site)! / r.xs.length);
    }
  }
  return trainLogistic(X, y, { l2, sampleWeight: w });
}

function modelFrom(fit: { bias: number; weights: number[] }, meta: Omit<LearnedModel, "bias" | "weights">): LearnedModel {
  const weights = Object.fromEntries(FEATURES.map((f, j) => [f, Math.round(fit.weights[j]! * 1000) / 1000])) as Record<FeatureName, number>;
  return { ...meta, bias: Math.round(fit.bias * 1000) / 1000, weights };
}

/** Of the k best-scored documents of a site, how many are labeled targets. */
function precisionAtK(scored: { score: number; y: number }[], k: number) {
  const top = [...scored].sort((a, b) => b.score - a.score).slice(0, k);
  return { hits: top.filter((t) => t.y === 1).length, n: top.length };
}

async function train() {
  const samples = await readJsonl<Sample>(LINKS);
  const labels = new Map((await readJsonl<Label>(LABELS)).map((l) => [l.id, l]));
  const rows = rowsFor(samples, labels);
  const sites = [...new Set(rows.map((r) => r.s.site))].sort();
  const L2 = 1;
  const meta = (siteCount: number, n: number, pos: number) => ({
    version: "learned-1",
    trainedAt: new Date().toISOString().slice(0, 10),
    trainedOn: { sites: siteCount, links: n, positives: pos, labeler: `${LABEL_MODEL}, prompt ${LABEL_PROMPT_VERSION}` },
  });

  // Leave one site out: fit on the other sites, score the held-out one, compare with the rules.
  const lines: string[] = [];
  const out = (s = "") => {
    console.log(s);
    lines.push(s);
  };
  out(`# Learned ranker · evaluation`);
  out("");
  out(
    `${rows.length} labeled links from ${sites.length} sites, ${rows.filter((r) => r.y).length} of them targets. Each site is scored by a model fitted on the other ${sites.length - 1} sites only. The reference is the LLM's label of every link. Precision@10 counts labeled targets among the ten best-scored documents of the site; ties in the rules score are broken by fiscal year, as in the API.`,
  );
  out("");
  out("| Site | Links | Targets | AUC rules | AUC learned | P@10 documents, rules | P@10 documents, learned |");
  out("|---|---|---|---|---|---|---|");
  const allRules: number[] = [];
  const allLearned: number[] = [];
  const allY: number[] = [];
  let pRules = 0;
  let pLearned = 0;
  let pN = 0;
  for (const site of sites) {
    const tr = rows.filter((r) => r.s.site !== site);
    const te = rows.filter((r) => r.s.site === site);
    const model = modelFrom(fitRows(tr, L2), meta(sites.length - 1, tr.length, 0));
    // The full learned score, policy multipliers included, as the crawler would store it.
    const learned = te.map((r) => scoreLinkLearned(candidate(r.s), scoreCtx(r.s), model).targetScore);
    const rules = te.map((r) => r.rules);
    const y = te.map((r) => r.y);
    allRules.push(...rules);
    allLearned.push(...learned);
    allY.push(...y);
    const docs = te.map((r, i) => ({ r, i })).filter(({ r }) => r.isDoc);
    const year = (r: Row) => scoreLink(candidate(r.s), scoreCtx(r.s)).fiscalYear ?? 0;
    const pr = precisionAtK(docs.map(({ r, i }) => ({ score: rules[i]! + year(r) / 1e7, y: r.y })), 10);
    const pl = precisionAtK(docs.map(({ r, i }) => ({ score: learned[i]! + year(r) / 1e7, y: r.y })), 10);
    pRules += pr.hits;
    pLearned += pl.hits;
    pN += pr.n;
    const f = (n: number) => (Number.isNaN(n) ? "-" : n.toFixed(2));
    out(`| ${site} | ${te.length} | ${y.filter(Boolean).length} | ${f(auc(rules, y))} | ${f(auc(learned, y))} | ${pr.hits}/${pr.n} | ${pl.hits}/${pl.n} |`);
  }
  out("");
  out(`**All sites:** AUC rules ${auc(allRules, allY).toFixed(3)}, learned ${auc(allLearned, allY).toFixed(3)}. Precision@10 on documents, summed over sites: rules ${pRules}/${pN}, learned ${pLearned}/${pN}.`);

  // The final model: every site, or every site but the excluded ones (to measure the test sites
  // with a model that never saw them: --exclude a2gov.org,asu.edu).
  const exIdx = process.argv.indexOf("--exclude");
  const exclude = new Set(exIdx > 0 ? process.argv[exIdx + 1]!.split(",") : []);
  const fitOn = rows.filter((r) => !exclude.has(r.s.site));
  const fitSites = new Set(fitOn.map((r) => r.s.site)).size;
  const model = modelFrom(fitRows(fitOn, L2), meta(fitSites, fitOn.length, fitOn.filter((r) => r.y).length));
  if (exclude.size) {
    await writeWeights(model, `fitted without ${[...exclude].join(", ")}: for measuring those sites only`);
    console.log(`\nwritten: src/ranking/learned-weights.ts, fitted on ${fitSites} sites without ${[...exclude].join(", ")}`);
    return;
  }
  out("");
  out("## Weights of the final model (fitted on every site)");
  out("");
  out("Log-odds per unit of each feature. Keyword features are multiplied by the keyword group's weight.");
  out("");
  out("| Feature | Weight |");
  out("|---|---|");
  out(`| (bias) | ${model.bias.toFixed(2)} |`);
  for (const f of [...FEATURES].sort((a, b) => model.weights[b] - model.weights[a])) out(`| ${f} | ${model.weights[f].toFixed(2)} |`);
  await writeFile(resolve(root, "eval/results-learned.md"), `${lines.join("\n")}\n`);
  await writeWeights(model, "fitted on every site");
  console.log("\nwritten: src/ranking/learned-weights.ts, eval/results-learned.md");
}

async function writeWeights(model: LearnedModel, note: string) {
  const body = JSON.stringify(model, null, 2).replace(/"([a-zA-Z_]+)":/g, "$1:");
  await writeFile(
    resolve(root, "src/ranking/learned-weights.ts"),
    `// Written by \`npm run learn -- train\` on ${model.trainedAt}, ${note}. Do not edit by hand:\n// change the data or the features and train again. Evaluation: eval/results-learned.md.\nimport type { LearnedModel } from "./learned.js";\n\nexport const LEARNED_MODEL: LearnedModel = ${body};\n`,
  );
}

// ---------------------------------------------------------------- main

const cmd = process.argv[2];
const maxIdx = process.argv.indexOf("--max");
const max = maxIdx > 0 ? Number(process.argv[maxIdx + 1]) : Infinity;
if (cmd === "train") {
  await train();
} else if (cmd === "dataset" || cmd === "label") {
  const ctx = await createContext({ log: { info: () => {}, warn: () => {}, error: (o) => console.error(o) } });
  try {
    if (cmd === "dataset") await buildDataset(ctx);
    else await label(ctx, max);
  } finally {
    await ctx.close();
  }
} else {
  console.error("usage: npm run learn -- dataset | label [--max N] | train");
  process.exit(1);
}
