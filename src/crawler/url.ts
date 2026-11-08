import { createHash } from "node:crypto";
import { getDomain, getSubdomain } from "tldts";

const TRACKING_PARAMS = new Set([
  "fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "_ga", "_gl", "igshid", "yclid",
]);
const SESSION_PARAMS = new Set(["sid", "sessionid", "session_id", "phpsessid", "jsessionid", "aspsessionid", "cfid", "cftoken"]);

/**
 * Normalizes a URL so that two spellings of the same page hash the same:
 * lowercase scheme and host (URL does this), default port and fragment removed, tracking and
 * session parameters removed, remaining parameters sorted. Returns null for anything that is
 * not an http(s) URL.
 */
export function normalizeUrl(raw: string, base?: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim(), base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  u.username = "";
  u.password = "";
  // ;jsessionid=... inside the path
  u.pathname = u.pathname.replace(/;(jsessionid|phpsessid|sid)=[^/]*/gi, "");
  const kept: [string, string][] = [];
  for (const [k, v] of u.searchParams) {
    const key = k.toLowerCase();
    if (key.startsWith("utm_") || TRACKING_PARAMS.has(key) || SESSION_PARAMS.has(key)) continue;
    kept.push([k, v]);
  }
  kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  u.search = "";
  for (const [k, v] of kept) u.searchParams.append(k, v);
  return u.toString();
}

export function urlHash(url: string): Buffer {
  return createHash("sha256").update(url).digest();
}

/** Host with the port when it is not the default one: robots.txt and politeness are per host:port. */
export function hostOf(url: string): string {
  return new URL(url).host;
}

const hostname = (host: string) => host.replace(/:\d+$/, "");

/** Registrable domain (asu.edu for cfo.asu.edu). Falls back to the host for IPs and localhost. */
export function registrableDomain(host: string): string {
  const name = hostname(host);
  return getDomain(name, { allowPrivateDomains: false }) ?? name;
}

export interface CrawlScope {
  /** Registrable domain of the seed. Every subdomain of it is in scope. */
  domain: string;
  /** Hosts that joined the scope during the crawl (redirect targets, entity-named hosts). */
  extraHosts: Set<string>;
}

export function inScope(url: string, scope: CrawlScope): boolean {
  const host = hostOf(url);
  if (scope.extraHosts.has(host)) return true;
  return registrableDomain(host) === scope.domain;
}

/**
 * A host on a vendor platform that carries the entity's own site name, such as
 * boerneisd.smartsiteshost.com for boerneisd.net. These are the entity's pages, hosted elsewhere.
 */
export function isEntityNamedHost(host: string, seedDomain: string): boolean {
  const label = seedDomain.split(".")[0] ?? "";
  if (label.length < 4) return false;
  const sub = getSubdomain(hostname(host)) ?? "";
  return sub.split(".").includes(label);
}

const DOC_EXTENSIONS: Record<string, string> = {
  pdf: "pdf", xlsx: "xlsx", xls: "xls", xlsm: "xlsx", csv: "csv", docx: "docx", doc: "doc",
  pptx: "pptx", ppt: "ppt", txt: "txt", rtf: "rtf", zip: "zip", odt: "odt", ods: "ods",
};
const SKIP_EXTENSIONS = new Set([
  "jpg", "jpeg", "png", "gif", "svg", "webp", "ico", "bmp", "tif", "tiff", "mp3", "mp4", "mov", "avi",
  "wmv", "webm", "m4a", "wav", "css", "js", "json", "xml", "rss", "woff", "woff2", "ttf", "eot", "ics", "exe", "dmg",
]);

/** File type from the URL's extension: a document type, "media" for things we never fetch, or null. */
export function fileTypeFromUrl(url: string): string | null {
  const u = new URL(url);
  const path = u.pathname.toLowerCase();
  // SharePoint share links name the file type in the path: /:b:/ is a PDF, /:x:/ a spreadsheet.
  if (u.hostname.endsWith(".sharepoint.com")) {
    const kind = path.match(/^\/:([bxwp]):\//)?.[1];
    if (kind) return { b: "pdf", x: "xlsx", w: "docx", p: "pptx" }[kind]!;
  }
  const m = path.match(/\.([a-z0-9]{2,5})$/);
  if (!m) return null;
  const ext = m[1]!;
  if (DOC_EXTENSIONS[ext]) return DOC_EXTENSIONS[ext]!;
  if (SKIP_EXTENSIONS.has(ext)) return "media";
  return null;
}

export function fileTypeFromContentType(contentType: string | null): string | null {
  if (!contentType) return null;
  const ct = contentType.toLowerCase();
  if (ct.includes("pdf")) return "pdf";
  if (ct.includes("spreadsheetml") || ct.includes("ms-excel")) return "xlsx";
  if (ct.includes("wordprocessingml") || ct.includes("msword")) return "docx";
  if (ct.includes("presentationml") || ct.includes("ms-powerpoint")) return "pptx";
  if (ct.includes("text/csv")) return "csv";
  if (ct.includes("html")) return "html";
  return null;
}

export const DOCUMENT_TYPES = new Set(Object.values(DOC_EXTENSIONS));

/**
 * Crawler traps: URLs that can generate endless pages. Returns the reason, or null if the URL
 * looks safe.
 */
export function trapReason(url: string, now = new Date()): string | null {
  const u = new URL(url);
  if (url.length > 400) return "url too long";
  const segments = u.pathname.split("/").filter(Boolean);
  const counts = new Map<string, number>();
  for (const s of segments) counts.set(s, (counts.get(s) ?? 0) + 1);
  if ([...counts.values()].some((c) => c >= 3)) return "repeating path";
  if ([...u.searchParams.keys()].length > 5) return "too many parameters";
  // Calendars: a date more than a year away from today, in the path or a date-like parameter.
  const thisYear = now.getFullYear();
  const dateText = `${u.pathname} ${[...u.searchParams.entries()]
    .filter(([k]) => /date|month|year|day|week|cal|start|end|time/i.test(k))
    .map(([, v]) => v)
    .join(" ")}`;
  const looksLikeCalendar = /calendar|event|schedule/i.test(u.pathname) || /date|month|day|week|cal/i.test(u.search);
  if (looksLikeCalendar) {
    for (const m of dateText.matchAll(/(?<!\d)(19|20)\d{2}(?!\d)/g)) {
      const year = Number(m[0]);
      if (Math.abs(year - thisYear) > 1) return "calendar date far from today";
    }
  }
  return null;
}
