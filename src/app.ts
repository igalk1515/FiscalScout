import { pino } from "pino";
import { type Config, config as defaultConfig, robotsToken, userAgent } from "./config.js";
import { Renderer } from "./crawler/render.js";
import { CrawlRunner, type Logger } from "./crawler/runner.js";
import { hostOf, normalizeUrl, registrableDomain, urlHash } from "./crawler/url.js";
import { createDb, type Db } from "./db/client.js";
import { migrate } from "./db/migrate.js";
import { EventBus } from "./events.js";
import { DEFAULT_KEYWORDS, type KeywordConfig } from "./ranking/keywords.js";
import { createLlm, dbCache, type LlmClient } from "./ranking/llm.js";
import { RANKER_VERSION } from "./ranking/rules.js";
import * as repo from "./store/repo.js";

export interface AppContext {
  config: Config;
  db: Db;
  events: EventBus;
  llm: LlmClient;
  runner: CrawlRunner;
  log: Logger;
  close(): Promise<void>;
}

export interface ContextOverrides {
  config?: Partial<Config>;
  db?: Db;
  llm?: LlmClient;
  log?: Logger;
}

/** Wires the database, event bus, LLM client and crawl runner together. */
export async function createContext(overrides: ContextOverrides = {}): Promise<AppContext> {
  const config = { ...defaultConfig, ...overrides.config };
  const log: Logger = overrides.log ?? pino({ level: config.LOG_LEVEL });
  const db = overrides.db ?? createDb(config.DATABASE_URL);
  await migrate(db);
  const events = new EventBus(db);
  await events.listen();
  const llm =
    overrides.llm ??
    createLlm({
      apiKey: config.OPENAI_API_KEY,
      model: config.OPENAI_MODEL,
      baseUrl: config.OPENAI_BASE_URL,
      cache: dbCache(db),
      onError: (m) => log.warn({ llm: m }, "LLM call failed; rules score kept"),
    });
  // The render tier starts a browser only when the first page needs it.
  const renderer = config.RENDER_JS
    ? new Renderer({
        userAgent,
        timeoutMs: config.RENDER_TIMEOUT_MS,
        channel: config.BROWSER_CHANNEL,
        executablePath: config.BROWSER_EXECUTABLE,
      })
    : null;
  const runner = new CrawlRunner({
    db,
    events,
    llm,
    rawDir: config.RAW_DIR,
    userAgent,
    robotsToken,
    workers: config.CRAWL_WORKERS,
    minDelayMs: config.MIN_HOST_DELAY_MS,
    llmMaxUsdPerCrawl: config.LLM_MAX_USD_PER_CRAWL,
    renderer,
    renderMaxPerCrawl: config.RENDER_MAX_PER_CRAWL,
    log,
  });
  return {
    config,
    db,
    events,
    llm,
    runner,
    log,
    async close() {
      await runner.stop();
      await renderer?.close();
      await events.close();
      if (!overrides.db) await db.end();
    },
  };
}

export class BadRequest extends Error {
  constructor(
    message: string,
    public param?: string,
  ) {
    super(message);
  }
}

export interface CrawlInput {
  url: string;
  keywords?: KeywordConfig;
  maxDepth?: number;
  pageBudget?: number;
  idempotencyKey?: string | null;
}

/** Creates a crawl and starts it in the background. A repeated idempotency key returns the first crawl. */
export async function startCrawl(ctx: AppContext, input: CrawlInput) {
  const seed = normalizeUrl(input.url);
  if (!seed) throw new BadRequest("url must be an http or https URL", "url");
  const host = hostOf(seed);
  const result = await repo.createCrawl(
    ctx.db,
    {
      seedUrl: seed,
      keywords: input.keywords ?? DEFAULT_KEYWORDS,
      maxDepth: input.maxDepth ?? 3,
      pageBudget: input.pageBudget ?? 300,
      scopeDomain: registrableDomain(host),
      rankerVersion: RANKER_VERSION,
      idempotencyKey: input.idempotencyKey ?? null,
    },
    { hash: urlHash(seed), host },
  );
  if (result.created) void ctx.runner.start(result.crawl.id);
  return result;
}
