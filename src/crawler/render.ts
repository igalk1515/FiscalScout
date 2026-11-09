import { type Browser, chromium } from "playwright-core";

export interface RendererOptions {
  userAgent: string;
  timeoutMs: number;
  /** "msedge" or "chrome": a browser already installed on the machine. */
  channel?: string;
  executablePath?: string;
  /** Most requests one page may make (scripts and data calls), so a page cannot run away. */
  maxRequests?: number;
}

export interface RenderResult {
  ok: boolean;
  html?: string;
  finalUrl?: string;
  status?: number;
  /** Why the rendered page was not used. */
  reason?: string;
  ms: number;
  requests: number;
}

/** Decides whether the browser may load a URL: robots.txt for pages and data calls. */
export type RequestCheck = (url: string, type: string) => Promise<boolean>;

/** Images, fonts, styles and media do not change the text or the links: never loaded. */
const SKIPPED_TYPES = new Set(["image", "media", "font", "stylesheet", "manifest", "texttrack", "eventsource", "websocket"]);
/** Request types that fetch content, checked against robots.txt like any page. */
const CHECKED_TYPES = new Set(["document", "xhr", "fetch"]);
/**
 * Pages that test whether the visitor is a person. We report them and stop; we do not solve them.
 * A bot-protection script on a page that loaded fully (many sites carry one) is not a check: the
 * markers count only when the page has almost no content of its own.
 */
const BOT_CHECK_TITLE = /just a moment|attention required|access denied|are you a robot|verify you are human|security check|captcha/i;
const BOT_CHECK_TEXT = /request unsuccessful\. incapsula|incapsula incident id|access to this page has been denied|press (&|and) hold|checking your browser|enable javascript and cookies to continue/i;
const BOT_CHECK_MARKERS = /cf-challenge|challenge-platform|g-recaptcha|h-captcha|hcaptcha\.com|px-captcha|_incapsula_|perimeterx/i;

/**
 * The render tier: a headless browser for pages that arrive as an empty shell and are drawn by
 * scripts. It is used after a normal fetch answered 200 with such a shell, never to get past a
 * refusal: a page that answers 401, 403 or 429, or shows a bot check, is reported and left alone.
 * One browser is shared; each page gets a fresh context, so no cookies carry over.
 */
export class Renderer {
  private browser: Promise<Browser> | null = null;

  constructor(private o: RendererOptions) {}

  private launch(): Promise<Browser> {
    this.browser ??= chromium.launch({
      headless: true,
      channel: this.o.executablePath ? undefined : this.o.channel,
      executablePath: this.o.executablePath,
    });
    return this.browser;
  }

  async render(url: string, check: RequestCheck): Promise<RenderResult> {
    const t0 = Date.now();
    let requests = 0;
    const done = (r: Omit<RenderResult, "ms" | "requests">): RenderResult => ({ ...r, ms: Date.now() - t0, requests });
    let browser: Browser;
    try {
      browser = await this.launch();
    } catch (err) {
      this.browser = null;
      return done({ ok: false, reason: `no browser could be started: ${(err as Error).message.split("\n")[0]}` });
    }
    const context = await browser.newContext({ userAgent: this.o.userAgent, serviceWorkers: "block", acceptDownloads: false });
    try {
      const page = await context.newPage();
      await page.route("**/*", async (route) => {
        const req = route.request();
        const type = req.resourceType();
        if (SKIPPED_TYPES.has(type)) return route.abort();
        if (!/^https?:/i.test(req.url())) return route.abort();
        if (++requests > (this.o.maxRequests ?? 60)) return route.abort();
        if (CHECKED_TYPES.has(type) && !(await check(req.url(), type).catch(() => false))) return route.abort();
        return route.continue();
      });
      const response = await page.goto(url, { waitUntil: "load", timeout: this.o.timeoutMs });
      const status = response?.status() ?? 0;
      if (status >= 400 || status === 0) return done({ ok: false, status, reason: `HTTP ${status} in the browser: not rendered, not bypassed` });
      // Scripts fetch their data after the load event: wait until the network is quiet, briefly.
      await page.waitForLoadState("networkidle", { timeout: Math.min(8000, this.o.timeoutMs) }).catch(() => {});
      const html = await page.content();
      const title = await page.title().catch(() => "");
      const text = String(await page.evaluate("document.body ? document.body.innerText : ''").catch(() => ""));
      if (BOT_CHECK_TITLE.test(title) || BOT_CHECK_TEXT.test(text) || (BOT_CHECK_MARKERS.test(html) && text.trim().length < 1000)) {
        return done({ ok: false, status, reason: "the page shows a bot check: reported, not bypassed" });
      }
      return done({ ok: true, html, finalUrl: page.url(), status });
    } catch (err) {
      return done({ ok: false, reason: `render failed: ${(err as Error).message.split("\n")[0]}` });
    } finally {
      await context.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    if (b) await (await b.catch(() => null))?.close().catch(() => {});
  }
}
