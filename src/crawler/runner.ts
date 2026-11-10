import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../db/client.js";
import type { EventBus } from "../events.js";
import { findContacts } from "../ranking/contacts.js";
import { compileKeywords, type CompiledGroup } from "../ranking/keywords.js";
import type { CallInfo, LlmClient } from "../ranking/llm.js";
import { rankerName, rankLink } from "../ranking/rank.js";
import { SOCIAL_HOSTS, type LinkScore } from "../ranking/rules.js";
import { applyLlmTier } from "../ranking/tier.js";
import * as repo from "../store/repo.js";
import { extractPage, parseHtml, type LinkCandidate } from "./extract.js";
import { fetchUrl, isRetryable } from "./fetcher.js";
import { saveRaw } from "./rawstore.js";
import type { Renderer, RenderResult } from "./render.js";
import { crawlDelayMs, fetchRobots, isAllowed, policyFromResponse, robotsUrlFor, type RobotsPolicy } from "./robots.js";
import {
  type CrawlScope,
  fileTypeFromContentType,
  hostOf,
  inScope,
  isEntityNamedHost,
  mirrorOf,
  normalizeUrl,
  trapReason,
  unmirror,
  urlHash,
} from "./url.js";

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface RunnerOptions {
  db: Db;
  events: EventBus;
  llm: LlmClient;
  rawDir: string;
  userAgent: string;
  robotsToken: string;
  workers: number;
  minDelayMs: number;
  log: Logger;
  /** Share of claims that pick a random queued URL instead of the best one. */
  exploreRate?: number;
  maxAttempts?: number;
  /** Hard cap on LLM spend per crawl, in dollars. */
  llmMaxUsdPerCrawl?: number;
  /** The render tier, when RENDER_JS is on: a headless browser for pages drawn by scripts. */
  renderer?: Renderer | null;
  /** Most pages one crawl may open in the browser. */
  renderMaxPerCrawl?: number;
}

interface CrawlState {
  crawl: repo.CrawlRow;
  groups: CompiledGroup[];
  scope: CrawlScope;
  claimed: number;
  contentHashes: Set<string>;
  /** Mirror host -> origin of the site it copies, learned from canonical links. */
  mirrors: Map<string, string>;
  /**
   * The entity's main site: the seed's host, where the seed redirects, and the host a mirrored
   * seed points to. These are not held to the per-host share of the budget.
   */
  mainHosts: Set<string>;
  /** Pages opened in the browser so far, and their URLs: many links can lead to the same page. */
  renders: number;
  renderedUrls: Set<string>;
  seedOutcome: { status: number; reason: string } | null;
  llmCalls: number;
  llmCost: number;
  /** Spend of the whole crawl so far, including earlier runs of it. */
  llmSpent: number;
  llmCapped: boolean;
  /** Set when the crawl is cancelled: workers claim nothing more. */
  cancelled: boolean;
}

const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BLOCKING_STATUSES = new Set([401, 403, 429, 451, 503]);
/** Sign-in and single-sign-on pages: never worth opening in the browser. */
const SIGN_IN_URL = /[/.?&=_-](log-?in|log-?on|sign-?in|sign-?on|sso|adfs|oauth2?|saml2?|cas\/login|auth(enticate|orize)?|idp)([/.?&=_-]|$)/i;

/**
 * Runs crawls. Each crawl is a set of async workers that claim URLs from the frontier table,
 * fetch them politely, rank what they find and queue new links. Workers only share the database,
 * so the same code runs as one process or many.
 */
export class CrawlRunner {
  private running = new Map<string, Promise<void>>();
  private states = new Map<string, CrawlState>();
  private readonly runnerId = randomUUID();
  private robots = new Map<string, { policy: RobotsPolicy; at: number }>();
  /** Reuse successful standard-agent requests instead of provoking another 403 on every page. */
  private standardAgentOrigins = new Set<string>();
  private stopping = false;

  constructor(private o: RunnerOptions) {}

  /** Starts a crawl if it is not already running. Resolves when it finishes. */
  start(crawlId: string): Promise<void> {
    const existing = this.running.get(crawlId);
    if (existing) return existing;
    const p = this.run(crawlId)
      .catch(async (err) => {
        this.o.log.error({ err, crawlId }, "crawl failed");
        await repo.setCrawlStatus(this.o.db, crawlId, "failed", (err as Error).message).catch(() => {});
        await this.o.events.emit(crawlId, "crawl.failed", { error: (err as Error).message }).catch(() => {});
      })
      .finally(() => this.running.delete(crawlId));
    this.running.set(crawlId, p);
    return p;
  }

  /** After a restart: continue crawls that were queued or running. */
  async resume(): Promise<void> {
    const r = await this.o.db.query<{ id: string }>("select id from crawls where status in ('queued', 'running') order by created_at");
    for (const { id } of r.rows) void this.start(id);
  }

  isRunning(crawlId: string) {
    return this.running.has(crawlId);
  }

  /**
   * Stops the workers of a cancelled crawl at once if it runs in this process; pages being
   * fetched finish. (A runner in another process learns it from its next heartbeat.) True when
   * the crawl runs here, so this runner will announce the end.
   */
  cancel(crawlId: string): boolean {
    const state = this.states.get(crawlId);
    if (state) state.cancelled = true;
    return this.running.has(crawlId);
  }

  /** Closes a cancelled crawl: skips what is still queued and announces it, once. */
  async settleCancelled(crawlId: string, pages: number): Promise<void> {
    await repo.skipQueued(this.o.db, crawlId, "crawl cancelled");
    const detail = `${repo.CANCEL_REQUESTED} after ${pages} pages`;
    if (await repo.settleCancelled(this.o.db, crawlId, detail)) await this.o.events.emit(crawlId, "crawl.cancelled", { detail, pages });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.running.values()]);
  }

  private async run(crawlId: string) {
    const { db, events } = this.o;
    const crawl = await repo.getCrawl(db, crawlId);
    if (!crawl || ["done", "blocked", "failed"].includes(crawl.status)) return;
    if (crawl.status === "cancelled") return this.settleCancelled(crawlId, crawl.pages_fetched + crawl.pages_failed);
    // One runner per crawl: if another process holds a fresh lease, leave the crawl to it.
    if (!(await repo.acquireCrawl(db, crawlId, this.runnerId))) {
      this.o.log.info({ crawlId }, "crawl is running in another process");
      return;
    }
    await repo.resetStale(db, crawlId);
    // False when the crawl was cancelled while it was starting.
    if (!(await repo.setCrawlStatus(db, crawlId, "running"))) return this.settleCancelled(crawlId, crawl.pages_fetched + crawl.pages_failed);
    const state: CrawlState = {
      crawl,
      groups: compileKeywords(crawl.keywords),
      scope: { domain: crawl.scope_domain, extraHosts: new Set(crawl.extra_hosts) },
      claimed: crawl.pages_fetched + crawl.pages_failed,
      contentHashes: new Set(),
      mirrors: new Map(),
      mainHosts: new Set([hostOf(crawl.seed_url)]),
      renders: 0,
      renderedUrls: new Set(),
      seedOutcome: null,
      llmCalls: 0,
      llmCost: 0,
      llmSpent: crawl.llm_cost_usd,
      llmCapped: false,
      cancelled: false,
    };
    this.states.set(crawlId, state);
    await events.emit(crawlId, "crawl.started", {
      seed: crawl.seed_url,
      max_depth: crawl.max_depth,
      page_budget: crawl.page_budget,
      keywords: Object.keys(crawl.keywords),
      respect_robots: crawl.respect_robots,
      llm: crawl.use_llm && this.o.llm.enabled ? this.o.llm.model : null,
      ranker: rankerName(crawl.ranker_version),
    });

    const ticker = setInterval(() => {
      void this.emitStats(state);
      void repo
        .heartbeat(db, crawlId, this.runnerId)
        .then((status) => {
          if (status === "cancelled") state.cancelled = true;
        })
        .catch(() => {});
    }, 1500);
    try {
      await Promise.all(Array.from({ length: this.o.workers }, () => this.worker(state)));
    } finally {
      clearInterval(ticker);
      this.states.delete(crawlId);
    }
    if (state.cancelled) return this.closeCancelled(state);

    const budgetHit = state.claimed >= crawl.page_budget;
    if (budgetHit) await repo.skipQueued(db, crawlId, "page budget reached");
    let status: repo.CrawlStatus = "done";
    let detail: string | null = budgetHit ? `stopped at the page budget of ${crawl.page_budget}` : null;
    if (state.seedOutcome) {
      const { status: code, reason } = state.seedOutcome;
      if (reason === "robots.txt" || BLOCKING_STATUSES.has(code)) {
        status = "blocked";
        detail =
          reason === "robots.txt"
            ? "robots.txt does not allow this bot on the start page"
            : `the site refused automated requests (HTTP ${code}); not bypassed`;
      } else {
        status = "failed";
        detail = `the start page could not be fetched: ${reason}`;
      }
    } else if (state.claimed === 0 && !this.stopping) {
      status = "failed";
      detail = "nothing could be fetched: the site is paused after errors in an earlier crawl";
    }
    if (this.stopping) return; // stopped mid-crawl: leave it running so a restart resumes it
    await this.emitStats(state);
    // Cancelled just as it finished: the cancel stands.
    if (!(await repo.setCrawlStatus(db, crawlId, status, detail))) return this.closeCancelled(state);
    await events.emit(crawlId, `crawl.${status}`, { detail, pages: state.claimed });
  }

  private async worker(state: CrawlState) {
    const { db } = this.o;
    const id = state.crawl.id;
    while (!this.stopping && !state.cancelled) {
      if (state.claimed >= state.crawl.page_budget) return;
      const explore = Math.random() < (this.o.exploreRate ?? 0.1);
      // No host other than the main site may take more than 30% of the budget, so one big
      // subdomain cannot crowd out the rest.
      const maxPerHost = Math.max(30, Math.ceil(state.crawl.page_budget * 0.3));
      const item = await repo.claimNext(db, id, explore, maxPerHost, state.mainHosts);
      if (!item) {
        const pending = await repo.pendingCounts(db, id);
        if (pending.queued === 0 && pending.fetching === 0) return;
        // Nothing can be claimed for a long time (every remaining host is paused or backing off):
        // finish instead of waiting, and say why.
        if (pending.fetching === 0 && (pending.waitSeconds ?? 0) > 960) {
          const n = await repo.skipQueued(db, id, "host paused or backing off for more than 16 minutes");
          await this.o.events.emit(id, "page.skipped", { url: state.crawl.seed_url, reason: `${n} queued URLs left: their hosts are paused` });
          return;
        }
        await sleep(150);
        continue;
      }
      if (item.capped) {
        await this.o.events.emit(id, "page.skipped", { url: item.url, reason: "host share of the page budget used" });
        continue;
      }
      state.claimed++;
      try {
        await this.process(state, item);
      } catch (err) {
        this.o.log.error({ err, url: item.url }, "page failed");
        await repo.finishItem(db, id, item.url_hash, "failed", null, `internal error: ${(err as Error).message}`.slice(0, 300));
        await repo.releaseHost(db, item.host, this.o.minDelayMs, "ok");
      }
    }
  }

  private async robotsFor(url: string): Promise<RobotsPolicy> {
    const host = hostOf(url);
    const cached = this.robots.get(host);
    if (cached && Date.now() - cached.at < ROBOTS_TTL_MS) return cached.policy;
    const stored = await repo.getRobots(this.o.db, host);
    // A stored 403 may predate the header fallback: refresh it once in this runner so that
    // newly accessible rules are not mistaken for an unavailable robots.txt file.
    if (stored && stored.status !== 403 && Date.now() - stored.fetchedAt.getTime() < ROBOTS_TTL_MS) {
      const policy = policyFromResponse(robotsUrlFor(url), stored.status, stored.text);
      this.robots.set(host, { policy, at: stored.fetchedAt.getTime() });
      return policy;
    }
    const fetched = await fetchRobots(url, this.o.userAgent, {
      standardAgentOrigins: this.standardAgentOrigins,
      fallbackDelayMs: Math.max(1000, this.o.minDelayMs),
    });
    await repo.saveRobots(this.o.db, host, fetched.status, fetched.text, crawlDelayMs(fetched.policy, this.o.robotsToken));
    this.robots.set(host, { policy: fetched.policy, at: Date.now() });
    return fetched.policy;
  }

  private onLlmCall = (state: CrawlState) => (c: CallInfo) => {
    if (!c.cached) state.llmCalls++;
    state.llmCost += c.costUsd;
    state.llmSpent += c.costUsd;
  };

  /** A disabled client when this crawl opts out or reaches its spending cap. */
  private llmFor(state: CrawlState): LlmClient {
    if (!state.crawl.use_llm) return { ...this.o.llm, enabled: false };
    const cap = this.o.llmMaxUsdPerCrawl ?? 0.5;
    if (!this.o.llm.enabled || state.llmSpent < cap) return this.o.llm;
    if (!state.llmCapped) {
      state.llmCapped = true;
      void this.o.events.emit(state.crawl.id, "llm.capped", { spent_usd: state.llmSpent, cap_usd: cap });
    }
    return { ...this.o.llm, enabled: false };
  }

  private async process(state: CrawlState, item: repo.FrontierItem) {
    const { db, events } = this.o;
    const id = state.crawl.id;
    const { scope } = state;

    // A URL queued before its host was known to be a mirror: queue the original instead (the
    // seen check drops it if it is already known) and spend no request on the copy.
    const original = unmirror(item.url, state.mirrors);
    if (original !== item.url) {
      await repo.enqueue(db, id, [
        { hash: urlHash(original), url: original, host: hostOf(original), depth: item.depth, pathScore: item.path_score, parent: item.parent_url ?? item.url, status: "queued", reason: null },
      ]);
      await repo.finishItem(db, id, item.url_hash, "skipped", null, `mirror of ${hostOf(original)}`);
      await repo.releaseHost(db, item.host, 0, "ok");
      state.claimed--;
      return;
    }

    // Only consult robots.txt when this crawl opts in.
    const policy = state.crawl.respect_robots ? await this.robotsFor(item.url) : null;
    if (policy && !isAllowed(policy, item.url, this.o.robotsToken)) {
      await repo.finishItem(db, id, item.url_hash, "skipped", null, "robots.txt");
      await repo.releaseHost(db, item.host, this.o.minDelayMs, "ok");
      if (item.depth === 0) state.seedOutcome = { status: 0, reason: "robots.txt" };
      await events.emit(id, "page.skipped", { url: item.url, reason: "robots.txt" });
      return;
    }
    const delay = Math.max(this.o.minDelayMs, policy ? crawlDelayMs(policy, this.o.robotsToken) ?? 0 : 0);

    await events.emit(id, "page.fetching", { url: item.url, depth: item.depth, path_score: item.path_score }, false);
    const r = await fetchUrl(item.url, {
      userAgent: this.o.userAgent,
      standardAgentOrigins: this.standardAgentOrigins,
      fallbackDelayMs: Math.max(1000, delay),
      beforeStandardAgentRequest: async (url) => {
        if (!state.crawl.respect_robots) return null;
        const rules = await this.robotsFor(url);
        return isAllowed(rules, url, this.o.robotsToken) && isAllowed(rules, url, "node") ? null : "robots.txt (standard HTTP client)";
      },
      onUserAgentFallback: async (url) => {
        await events.emit(id, "page.retrying", { url, status: 403, reason: "configured User-Agent refused; retrying with the standard HTTP client" });
      },
      beforeRedirect: async (_from, to) => {
        const next = normalizeUrl(to);
        if (!next) return "invalid redirect";
        if (SOCIAL_HOSTS.test(hostOf(next))) return "redirect out of scope";
        if (item.depth === 0) state.mainHosts.add(hostOf(next));
        if (!inScope(next, scope) && item.depth === 0) {
          // The start page moved to another domain (bozeman.net -> bozemanmt.gov): follow the site.
          scope.extraHosts.add(hostOf(next));
          await repo.addExtraHost(db, id, hostOf(next));
          await events.emit(id, "scope.added", { host: hostOf(next), reason: "the start page redirects there" });
        }
        if (!state.crawl.respect_robots) return null;
        const p = await this.robotsFor(next);
        return isAllowed(p, next, this.o.robotsToken) ? null : "robots.txt (redirect target)";
      },
    });

    // Release the site: one request at a time, at least `delay` apart, longer for slow sites, and
    // backing off further while the site answers 429 or 503 ("slow down").
    const slowDown = r.status === 429 || r.status === 503;
    const outcome: repo.FetchOutcome = slowDown ? "slow_down" : r.status === 0 || r.status >= 500 || r.status === 403 ? "error" : "ok";
    const blocked = await repo.releaseHost(db, item.host, Math.max(delay, Math.min(10_000, r.ms)), outcome, r.retryAfterMs ?? 0);
    if (blocked) {
      const n = await repo.skipQueued(db, id, "host paused for 15 minutes after repeated errors", item.host);
      await events.emit(id, "host.paused", { host: item.host, skipped: n });
    }

    if (r.error && r.status >= 300 && r.status < 400) {
      await repo.finishItem(db, id, item.url_hash, "skipped", r.status, r.error);
      await events.emit(id, "page.skipped", { url: item.url, reason: r.error });
      return;
    }

    if (r.error?.startsWith("robots.txt")) {
      await repo.finishItem(db, id, item.url_hash, "skipped", null, r.error);
      if (item.depth === 0) state.seedOutcome = { status: 0, reason: "robots.txt" };
      await events.emit(id, "page.skipped", { url: item.url, reason: r.error });
      return;
    }

    const failed = r.status === 0 || r.status >= 400;
    if (failed) {
      const reason = r.error ?? `HTTP ${r.status}`;
      const attemptsAllowed = slowDown ? 5 : this.o.maxAttempts ?? 3;
      if (isRetryable(r) && item.attempts < attemptsAllowed) {
        const backoff = r.retryAfterMs ?? 2 ** item.attempts * 1000 + Math.floor(Math.random() * 500);
        await repo.requeueItem(db, id, item.url_hash, Math.min(backoff, 60_000), `retry after ${reason}`);
        state.claimed--; // a retry does not use the page budget
        await events.emit(id, "page.failed", { url: item.url, status: r.status, reason, retrying: true });
        return;
      }
      await repo.finishItem(db, id, item.url_hash, "failed", r.status || null, reason);
      await repo.bumpCrawl(db, id, { failed: 1 });
      if (item.depth === 0) state.seedOutcome = { status: r.status, reason };
      await events.emit(id, "page.failed", { url: item.url, status: r.status, reason, retrying: false, parent: item.parent_url });
      return;
    }

    // A document behind a URL that did not say so (".../DocumentCenter/View/2087").
    if (!r.isHtml || !r.body) {
      const fileType = fileTypeFromContentType(r.contentType);
      await repo.markDocument(db, id, item.url_hash, fileType);
      await repo.finishItem(db, id, item.url_hash, "done", r.status, `not HTML (${r.contentType ?? "unknown type"})`);
      await repo.bumpCrawl(db, id, { fetched: 1 });
      await events.emit(id, "page.fetched", { url: item.url, status: r.status, ms: r.ms, links: 0, document: fileType });
      return;
    }

    const finalUrl = normalizeUrl(r.finalUrl) ?? r.finalUrl;
    const contentHash = createHash("sha256").update(r.body).digest();
    let duplicate: string | null = state.contentHashes.has(contentHash.toString("hex")) ? "same content as a page already read" : null;
    state.contentHashes.add(contentHash.toString("hex"));
    let rawPath = await saveRaw(this.o.rawDir, item.url_hash, r.body);
    let $ = parseHtml(r.body.toString("utf8"));
    let page = extractPage($, finalUrl);
    const needsBrowser = page.thin;

    // Render tier: an empty shell on the entity's own site that answered 200 is opened in the
    // browser, within the crawl's render budget. Anything that refused us never gets here.
    // Not a copy of a page already read, not a page already rendered (several links can redirect
    // to one page), and not a sign-in page, which holds nothing to find.
    let rendered = false;
    const { renderer } = this.o;
    if (
      needsBrowser &&
      renderer &&
      r.status === 200 &&
      !duplicate &&
      !state.renderedUrls.has(finalUrl) &&
      !SIGN_IN_URL.test(finalUrl) &&
      inScope(finalUrl, scope) &&
      state.renders < (this.o.renderMaxPerCrawl ?? 20)
    ) {
      state.renders++;
      state.renderedUrls.add(finalUrl);
      const rr = await this.renderPage(renderer, item, finalUrl, state.crawl.respect_robots);
      if (rr.ok && rr.html) {
        const $r = parseHtml(rr.html);
        const pr = extractPage($r, finalUrl);
        if (pr.links.length > page.links.length || pr.visibleTextLength > page.visibleTextLength) {
          [$, page, rendered] = [$r, pr, true];
          rawPath = await saveRaw(this.o.rawDir, item.url_hash, Buffer.from(rr.html, "utf8"));
        }
        await events.emit(id, "page.rendered", { url: finalUrl, ms: rr.ms, requests: rr.requests, links: pr.links.length, used: rendered });
      } else {
        await events.emit(id, "page.render_failed", { url: finalUrl, reason: rr.reason });
      }
    }

    // The same site under a second host name: its pages name the original as canonical.
    // Learn the mirror once, then read every URL on it under the original host.
    const mirror = mirrorOf(finalUrl, page.canonical, scope);
    if (mirror) {
      if (!state.mirrors.has(mirror.host)) {
        state.mirrors.set(mirror.host, mirror.origin);
        if (state.mainHosts.has(mirror.host)) state.mainHosts.add(new URL(mirror.origin).host);
        await events.emit(id, "scope.mirror", { host: mirror.host, same_as: new URL(mirror.origin).host, page: finalUrl });
      }
      const canonical = page.canonical!;
      const fresh = await repo.markReadAs(db, id, {
        hash: urlHash(canonical), url: canonical, host: hostOf(canonical), depth: item.depth, pathScore: item.path_score, parent: item.url, status: "skipped", reason: `read as ${item.url}`,
      });
      if (!fresh && !duplicate) duplicate = `same page as ${canonical}, already read`;
    }
    if (state.mirrors.size) {
      const byUrl = new Map<string, LinkCandidate>();
      for (const l of page.links) {
        const url = unmirror(l.url, state.mirrors);
        const prev = byUrl.get(url);
        if (!prev || (prev.boilerplate && !l.boilerplate)) byUrl.set(url, { ...l, url });
      }
      page.links = [...byUrl.values()];
    }
    /** Where a person reading the results should go: the original, not the mirror copy. */
    const shownUrl = mirror ? page.canonical! : finalUrl;
    const xRobots = (r.headers["x-robots-tag"] ?? "").toLowerCase();
    const nofollow = state.crawl.respect_robots && (page.metaNofollow || /\b(nofollow|none)\b/.test(xRobots));

    const pageId = await repo.upsertPage(db, {
      hash: item.url_hash,
      url: item.url,
      finalUrl,
      host: hostOf(finalUrl),
      status: r.status,
      contentType: r.contentType,
      contentHash,
      bytes: r.bytes,
      title: page.title || null,
      rawPath,
      needsBrowser,
      rendered,
    });

    if (duplicate) {
      await repo.finishItem(db, id, item.url_hash, "done", r.status, duplicate);
      await repo.bumpCrawl(db, id, { fetched: 1 });
      await events.emit(id, "page.fetched", { url: item.url, status: r.status, ms: r.ms, links: 0, duplicate: true });
      return;
    }

    // ---- rank every link on the page
    const scored = page.links.map((link) => ({
      link,
      s: rankLink(link, { groups: state.groups, parentPathScore: item.path_score, internal: inScope(link.url, scope) }, state.crawl.ranker_version),
    }));
    await applyLlmTier(this.llmFor(state), state.groups, scored, this.onLlmCall(state));

    const results = scored.filter((x) => x.s.targetScore > 0);
    const saved = await repo.saveLinks(
      db,
      id,
      pageId,
      item.depth,
      state.crawl.ranker_version,
      results.map(({ link, s }) => ({
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
    for (const l of saved.filter((x) => x.isNew && x.targetScore >= 0.5).slice(0, 25)) {
      await events.emit(id, "link.found", {
        url: l.url,
        type: l.type,
        doc_type: l.docType,
        fiscal_year: l.fiscalYear,
        score: l.targetScore,
        page: item.url,
      });
    }

    // ---- contacts
    const contacts = await findContacts($, page.dataBlocks, {
      groups: state.groups,
      entityDomain: scope.domain,
      pagePathScore: item.path_score,
      llm: this.llmFor(state),
      onLlmCall: this.onLlmCall(state),
    });
    if (contacts.length) {
      const fresh = await repo.saveContacts(
        db,
        id,
        contacts.map((c) => ({
          host: hostOf(shownUrl),
          name: c.name,
          title: c.title,
          email: c.email,
          phone: c.phone,
          score: c.score,
          matchedKeywords: c.matchedKeywords,
          sourcePageId: pageId,
          sourceUrl: shownUrl,
          snippet: c.snippet,
          decidedBy: c.decidedBy,
        })),
      );
      for (const c of contacts.filter((x) => fresh.includes(x.name))) {
        await events.emit(id, "contact.found", { name: c.name, title: c.title, email: c.email, score: c.score, page: shownUrl });
      }
    }

    // ---- queue the pages worth visiting
    if (!nofollow) await this.enqueueLinks(state, item, scored.filter((x) => x.s.type === "page" && !x.s.noise));

    await repo.finishItem(db, id, item.url_hash, "done", r.status, nofollow ? "nofollow: links recorded, not followed" : null);
    await repo.bumpCrawl(db, id, { fetched: 1 });
    await events.emit(id, "page.fetched", {
      url: item.url,
      final_url: finalUrl !== item.url ? finalUrl : undefined,
      status: r.status,
      ms: r.ms,
      depth: item.depth,
      path_score: item.path_score,
      links: page.links.length,
      results: results.length,
      contacts: contacts.length,
      needs_browser: (needsBrowser && !rendered) || undefined,
      rendered: rendered || undefined,
      user_agent_fallback: r.userAgentFallback || undefined,
    });
  }

  /**
   * Opens one page in the browser as one polite visit: it holds the site's lease like a fetch,
   * applying the crawl's robots.txt setting to browser pages and data requests too.
   */
  private async renderPage(renderer: Renderer, item: repo.FrontierItem, url: string, respectRobots: boolean): Promise<RenderResult> {
    const { db } = this.o;
    if (!(await repo.acquireSite(db, item.host))) return { ok: false, reason: "the site stayed busy", ms: 0, requests: 0 };
    let rr: RenderResult | undefined;
    try {
      rr = await renderer.render(url, async (u) => !respectRobots || isAllowed(await this.robotsFor(u), u, this.o.robotsToken));
      return rr;
    } finally {
      // A 429 or 503 in the browser means slow down, exactly as for a fetch.
      const outcome: repo.FetchOutcome = rr?.status === 429 || rr?.status === 503 ? "slow_down" : "ok";
      await repo.releaseHost(db, item.host, Math.max(this.o.minDelayMs, Math.min(10_000, rr?.ms ?? 0)), outcome);
    }
  }

  private async enqueueLinks(state: CrawlState, item: repo.FrontierItem, pages: { link: LinkCandidate; s: LinkScore }[]) {
    const { db, events } = this.o;
    const id = state.crawl.id;
    const rows: repo.EnqueueRow[] = [];
    const seen = new Set<string>();
    for (const { link, s } of pages) {
      if (seen.has(link.url)) continue;
      seen.add(link.url);
      const host = hostOf(link.url);
      let inside = inScope(link.url, state.scope);
      if (!inside && isEntityNamedHost(host, state.scope.domain)) {
        // The entity's own pages on a vendor platform (boerneisd.smartsiteshost.com).
        state.scope.extraHosts.add(host);
        await repo.addExtraHost(db, id, host);
        await events.emit(id, "scope.added", { host, reason: "the host carries the entity's site name" });
        inside = true;
      }
      const trap = inside ? trapReason(link.url) : null;
      const tooDeep = item.depth + 1 > state.crawl.max_depth;
      const reason = !inside ? "out of scope" : trap ? `trap: ${trap}` : tooDeep ? "beyond max depth" : state.crawl.respect_robots && link.nofollow ? "rel=nofollow" : null;
      rows.push({
        hash: urlHash(link.url),
        url: link.url,
        host,
        depth: item.depth + 1,
        pathScore: s.pathScore,
        parent: item.url,
        status: reason ? "skipped" : "queued",
        reason,
      });
    }
    // Never queue on a host that is paused.
    const paused = new Set(await repo.pausedHosts(db, [...new Set(rows.map((r) => r.host))]));
    for (const r of rows) if (r.status === "queued" && paused.has(r.host)) Object.assign(r, { status: "skipped", reason: "host paused" });

    const fresh = await repo.enqueue(db, id, rows);
    // Keep the live feed readable: report skips that matter, not every link to another site.
    const byUrl = new Map(rows.map((r) => [r.url, r]));
    for (const f of fresh.filter((f) => f.status === "skipped")) {
      const row = byUrl.get(f.url)!;
      if (f.reason === "out of scope" && row.pathScore < 0.3) continue;
      await events.emit(id, "page.skipped", { url: f.url, reason: f.reason, path_score: row.pathScore });
    }
  }

  /** After the workers of a cancelled crawl stop: skip the queue, send the final counters, announce. */
  private async closeCancelled(state: CrawlState) {
    await repo.skipQueued(this.o.db, state.crawl.id, "crawl cancelled");
    await this.emitStats(state);
    await this.settleCancelled(state.crawl.id, state.claimed);
  }

  private async emitStats(state: CrawlState) {
    const id = state.crawl.id;
    try {
      if (state.llmCalls || state.llmCost) {
        await repo.bumpCrawl(this.o.db, id, { llmCalls: state.llmCalls, llmCost: state.llmCost });
        state.llmCalls = 0;
        state.llmCost = 0;
      }
      const c = await repo.crawlCounters(this.o.db, id);
      const crawl = await repo.getCrawl(this.o.db, id);
      await this.o.events.emit(id, "stats", { ...c, llm_calls: crawl?.llm_calls ?? 0, llm_cost_usd: crawl?.llm_cost_usd ?? 0 }, false);
    } catch (err) {
      this.o.log.warn({ err }, "stats failed");
    }
  }
}
