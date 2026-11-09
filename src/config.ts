import { z } from "zod";

// Load .env when present. Real environment variables win over the file.
try {
  process.loadEnvFile(".env");
} catch {
  // no .env file: defaults below apply
}

const Env = z.object({
  DATABASE_URL: z.string().default("postgres://scraper:scraper@localhost:5433/scraper"),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default("0.0.0.0"),
  RAW_DIR: z.string().default("data/raw"),
  OPENAI_API_KEY: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined)),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_BASE_URL: z.string().default("https://api.openai.com/v1"),
  /** Hard cap on LLM spend per crawl. Past it, the crawl continues on rules alone. */
  LLM_MAX_USD_PER_CRAWL: z.coerce.number().min(0).default(0.5),
  BOT_NAME: z.string().default("HighValueLinkScraper/0.1"),
  BOT_URL: z.string().default("https://github.com/igalk1515/high-value-link-scraper"),
  CRAWL_WORKERS: z.coerce.number().int().min(1).max(16).default(3),
  MIN_HOST_DELAY_MS: z.coerce.number().int().min(0).default(1000),
  /**
   * Render tier: open pages drawn entirely by scripts in a headless browser. Off by default.
   * Only pages on the entity's own site that answered 200 with an empty shell are rendered;
   * a page that refused us is never opened in a browser.
   */
  RENDER_JS: z
    .string()
    .optional()
    .transform((v) => ["1", "true", "yes", "on"].includes((v ?? "").trim().toLowerCase())),
  RENDER_MAX_PER_CRAWL: z.coerce.number().int().min(0).default(20),
  RENDER_TIMEOUT_MS: z.coerce.number().int().min(1000).default(20000),
  /** A browser already on the machine: "msedge" or "chrome", or a path to the executable. */
  BROWSER_CHANNEL: z.string().optional(),
  BROWSER_EXECUTABLE: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
});

export type Config = z.infer<typeof Env>;

export const config: Config = Env.parse(process.env);

/** Honest identification: the bot's name and a page that explains it. */
export const userAgent = `${config.BOT_NAME} (+${config.BOT_URL})`;

/** The product token robots.txt groups are matched against. */
export const robotsToken = config.BOT_NAME.split("/")[0]!;
