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
  LOG_LEVEL: z.string().default("info"),
});

export type Config = z.infer<typeof Env>;

export const config: Config = Env.parse(process.env);

/** Honest identification: the bot's name and a page that explains it. */
export const userAgent = `${config.BOT_NAME} (+${config.BOT_URL})`;

/** The product token robots.txt groups are matched against. */
export const robotsToken = config.BOT_NAME.split("/")[0]!;
