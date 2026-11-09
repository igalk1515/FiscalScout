import { setTimeout as delay } from "node:timers/promises";

export interface FetchOptions {
  userAgent: string;
  timeoutMs?: number;
  /** Stop reading the body after this many bytes. */
  maxBytes?: number;
  maxRedirects?: number;
  /** Read the body only for HTML (default) or for any content type. */
  readBody?: "html" | "any";
  /**
   * Called before following a redirect. Return a reason to stop there (out of scope, blocked by
   * robots.txt), or null to follow it.
   */
  beforeRedirect?: (from: string, to: string) => Promise<string | null>;
  accept?: string;
  /** Origins where the runtime's standard User-Agent has already succeeded after a 403. */
  standardAgentOrigins?: Set<string>;
  /** Wait before the single User-Agent fallback, while still holding the caller's host lease. */
  fallbackDelayMs?: number;
  /** Apply any additional policy before a request using the standard User-Agent. */
  beforeStandardAgentRequest?: (url: string) => Promise<string | null>;
  onUserAgentFallback?: (url: string) => Promise<void>;
}

export interface FetchResult {
  url: string;
  finalUrl: string;
  /** HTTP status of the last response, or 0 when no response arrived. */
  status: number;
  contentType: string | null;
  isHtml: boolean;
  body: Buffer | null;
  bytes: number;
  truncated: boolean;
  ms: number;
  redirects: string[];
  /** Network error, timeout, redirect loop, or the reason a redirect was not followed. */
  error?: string;
  retryAfterMs?: number;
  headers: Record<string, string>;
  /** This request used Node's standard User-Agent after the site's custom-agent rejection. */
  userAgentFallback: boolean;
}

/** Whether trying again later could help, after any request-header fallback has finished. */
export function isRetryable(r: FetchResult): boolean {
  if (r.error && r.status === 0) return true; // network error or timeout
  return r.status === 429 || r.status >= 500;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * Fetches with the crawler's User-Agent first. A 403 gets one paced retry using Node's own
 * standard User-Agent. The whole exchange shares a timeout, redirect limit and size cap.
 * Non-HTML bodies are not downloaded unless asked for.
 */
export async function fetchUrl(url: string, opts: FetchOptions): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 5;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const redirects: string[] = [];
  let current = url;
  const standardAgentOrigins = opts.standardAgentOrigins ?? new Set<string>();
  const triedStandardAgent = new Set<string>();
  let userAgentFallback = false;

  const result = (partial: Partial<FetchResult>): FetchResult => ({
    url,
    finalUrl: current,
    status: 0,
    contentType: null,
    isHtml: false,
    body: null,
    bytes: 0,
    truncated: false,
    ms: Date.now() - started,
    redirects,
    headers: {},
    userAgentFallback,
    ...partial,
  });

  try {
    for (let hop = 0; ;) {
      const origin = new URL(current).origin;
      const standardAgent = standardAgentOrigins.has(origin) || triedStandardAgent.has(current);
      if (standardAgent) {
        const stop = await opts.beforeStandardAgentRequest?.(current);
        if (stop) return result({ status: 403, error: stop });
        userAgentFallback = true;
      }
      const res = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          ...(standardAgent ? {} : { "user-agent": opts.userAgent }),
          accept: opts.accept ?? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          "accept-language": "en-US,en;q=0.8",
        },
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k] = v));

      if (res.status === 403 && !standardAgent) {
        await res.body?.cancel().catch(() => {});
        triedStandardAgent.add(current);
        await opts.onUserAgentFallback?.(current);
        await delay(opts.fallbackDelayMs ?? 1000, undefined, { signal: controller.signal });
        continue;
      }
      if (standardAgent && res.status >= 200 && res.status < 400) standardAgentOrigins.add(origin);

      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        await res.body?.cancel().catch(() => {});
        const next = new URL(res.headers.get("location")!, current).toString();
        if (hop >= maxRedirects) return result({ status: res.status, headers, error: "too many redirects" });
        if (next === current || redirects.includes(next) || next === url) {
          return result({ status: res.status, headers, error: "redirect loop" });
        }
        if (opts.beforeRedirect) {
          const stop = await opts.beforeRedirect(current, next);
          if (stop) return result({ status: res.status, headers, error: stop, finalUrl: next });
        }
        redirects.push(next);
        current = next;
        hop++;
        continue;
      }

      const contentType = res.headers.get("content-type");
      const isHtml = !!contentType && /text\/html|application\/xhtml\+xml/i.test(contentType);
      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
      const wantBody = res.ok && (opts.readBody === "any" || isHtml);
      if (!wantBody || !res.body) {
        await res.body?.cancel().catch(() => {});
        return result({ status: res.status, headers, contentType, isHtml, retryAfterMs });
      }

      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > maxBytes) {
        await res.body.cancel().catch(() => {});
        return result({ status: res.status, headers, contentType, isHtml, truncated: true, error: "too large" });
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
          truncated = true;
          break;
        }
        chunks.push(Buffer.from(chunk));
      }
      if (truncated) controller.abort();
      const body = Buffer.concat(chunks);
      return result({ status: res.status, headers, contentType, isHtml, body, bytes: body.length, truncated, retryAfterMs });
    }
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    const reason = controller.signal.aborted ? "timeout" : e.cause?.code ?? e.message;
    return result({ error: reason });
  } finally {
    clearTimeout(timer);
  }
}
