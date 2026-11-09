import { z } from "zod";

const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

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
  HTTP_USER_AGENT: z.string().trim().min(1).default(DEFAULT_USER_AGENT),
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

/** The configured request header, shared by HTTP fetches, robots.txt and browser rendering. */
export const userAgent = config.HTTP_USER_AGENT;

export function robotsTokenFor(agent: string): string {
  return agent.split(/[\/\s]/, 1)[0]!;
}

/** The product token robots.txt groups are matched against. */
export const robotsToken = robotsTokenFor(userAgent);
