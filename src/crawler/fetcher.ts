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
}

/** Whether trying again later could give a different answer. 4xx never does. */
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
 * Fetches one URL politely: an honest User-Agent, a timeout for the whole exchange, at most
 * `maxRedirects` redirects with a loop check, and a size cap. Non-HTML bodies are not
 * downloaded unless asked for.
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
    ...partial,
  });

  try {
    for (let hop = 0; ; hop++) {
      const res = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": opts.userAgent,
          accept: opts.accept ?? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          "accept-language": "en-US,en;q=0.8",
        },
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k] = v));

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
