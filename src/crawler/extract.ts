import { load, type CheerioAPI } from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { normalizeUrl } from "./url.js";

export interface LinkCandidate {
  /** Normalized absolute URL. */
  url: string;
  /** Visible text, or title / aria-label / image alt when the link has no text. */
  anchor: string;
  /** The title attribute. Sites often put the file's real name here. */
  titleAttr: string;
  /** Nearest heading above the link. Anchors like "Fiscal Year 2025" only make sense with it. */
  heading: string;
  /** Text around the link, about 200 characters. */
  context: string;
  /** Inside navigation, header, footer or a menu. */
  boilerplate: boolean;
  nofollow: boolean;
  /** "data" when the link came from JSON embedded in the page rather than an <a> tag. */
  source: "html" | "data";
}

export interface PageExtract {
  title: string;
  canonical: string | null;
  metaNofollow: boolean;
  metaNoindex: boolean;
  links: LinkCandidate[];
  /** Text blocks from JSON embedded in the page (cards and menus that scripts render later). */
  dataBlocks: string[];
  visibleTextLength: number;
  /** The HTML looks like an empty shell that a script fills in: a browser would be needed. */
  thin: boolean;
}

const ZERO_WIDTH = /[​-‍⁠﻿­]/g;

/** Removes zero-width characters, turns non-breaking spaces into spaces, collapses whitespace. */
export function cleanText(s: string): string {
  return s.replace(ZERO_WIDTH, "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

const BLOCK_TAGS = new Set([
  "p", "div", "li", "ul", "ol", "dl", "dt", "dd", "tr", "td", "th", "table", "section", "article",
  "header", "footer", "aside", "h1", "h2", "h3", "h4", "h5", "h6", "address", "blockquote", "figure",
  "figcaption", "main", "nav", "form", "fieldset",
]);
const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "svg", "iframe"]);

/** Text of an element with line breaks kept at <br> and block boundaries. */
export function blockText(node: AnyNode): string {
  const parts: string[] = [];
  const walk = (n: AnyNode) => {
    if (n.type === "text") {
      parts.push((n as unknown as { data: string }).data);
      return;
    }
    if (n.type !== "tag" && n.type !== "root") return;
    const el = n as Element;
    if (n.type === "tag" && SKIP_TAGS.has(el.name)) return;
    if (n.type === "tag" && el.name === "br") {
      parts.push("\n");
      return;
    }
    const block = n.type === "tag" && BLOCK_TAGS.has(el.name);
    if (block) parts.push("\n");
    for (const c of el.children ?? []) walk(c);
    if (block) parts.push("\n");
  };
  walk(node);
  return parts
    .join("")
    .split("\n")
    .map(cleanText)
    .filter(Boolean)
    .join("\n");
}

const BOILERPLATE_SELECTOR =
  "nav, header, footer, [role=navigation], [role=banner], [role=contentinfo], [role=menu], [role=menubar]";
const BOILERPLATE_CLASS = /(^|[\s_-])(nav|navbar|navigation|menu|megamenu|footer|header|breadcrumbs?|sidebar|utility)([\s_-]|$)/i;

function inBoilerplate($: CheerioAPI, el: Element): boolean {
  if ($(el).closest(BOILERPLATE_SELECTOR).length) return true;
  let cur: Element | null = el.parent as Element | null;
  for (let depth = 0; cur && depth < 12; depth++) {
    const cls = `${cur.attribs?.class ?? ""} ${cur.attribs?.id ?? ""}`;
    if (cls.trim() && BOILERPLATE_CLASS.test(cls)) return true;
    cur = cur.parent as Element | null;
  }
  return false;
}

function anchorText($: CheerioAPI, el: Element): string {
  const a = $(el);
  const visible = cleanText(a.text());
  if (visible) return visible;
  return cleanText(a.attr("aria-label") ?? a.attr("title") ?? a.find("img[alt]").first().attr("alt") ?? "");
}

function contextFor($: CheerioAPI, el: Element, anchor: string): string {
  const block = $(el).closest("li, p, td, dd, tr, figcaption, article");
  let text = cleanText((block.length ? block : $(el).parent()).text());
  if (!text || text === anchor) {
    // A list item that holds only the link: use the text just before the whole list, so every
    // item of the list gets the same context (not its neighbour's link text).
    const list = $(el).closest("ul, ol, table");
    const before = (list.length ? list : block.length ? block : $(el)).prev();
    text = cleanText(before.text());
  }
  if (text.length <= 200) return text;
  const at = text.indexOf(anchor);
  const start = Math.max(0, at < 0 ? 0 : at - 80);
  return text.slice(start, start + 200);
}

/** Parses HTML once so the extractor and the contact finder can share the document. */
export function parseHtml(html: string): CheerioAPI {
  return load(html);
}

export function extractPage(html: string | CheerioAPI, pageUrl: string): PageExtract {
  const $ = typeof html === "string" ? parseHtml(html) : html;
  const baseHref = $("base[href]").attr("href");
  const base = (baseHref && normalizeUrl(baseHref, pageUrl)) || pageUrl;
  const pageNorm = normalizeUrl(pageUrl) ?? pageUrl;

  const robotsMeta = ($('meta[name="robots" i]').attr("content") ?? "").toLowerCase();
  const canonicalHref = $('link[rel="canonical" i]').attr("href");

  const links = new Map<string, LinkCandidate>();
  // A real heading (h1-h6) names the section. A bold line alone in a paragraph ("Recent Operating
  // Budget Submissions:") often names the list below it, but it can also be a sidebar label
  // ("Contact Us"), so it is added to the real heading instead of replacing it.
  let realHeading = "";
  let pseudoHeading = "";
  const HEADINGS = "h1, h2, h3, h4, h5, h6, [role=heading], summary, p > strong:only-child, p > b:only-child";
  $(`${HEADINGS}, a[href]`).each((_, node) => {
    const el = node as Element;
    if (el.name !== "a") {
      // Headings for screen readers only ("Breadcrumb") say nothing about the content below.
      if ($(el).closest(".visually-hidden, .sr-only, .element-invisible, .screen-reader-text").length) return;
      const t = cleanText($(el).text());
      const pseudo = el.name === "strong" || el.name === "b";
      if (pseudo && cleanText($(el).parent().text()) !== t) return;
      if (!t || t.length > 200) return;
      if (pseudo) pseudoHeading = t.replace(/:$/, "");
      else {
        realHeading = t;
        pseudoHeading = "";
      }
      return;
    }
    const heading = pseudoHeading ? (realHeading ? `${realHeading} › ${pseudoHeading}` : pseudoHeading) : realHeading;
    const url = normalizeUrl($(el).attr("href") ?? "", base);
    if (!url || url === pageNorm) return;
    const anchor = anchorText($, el);
    const candidate: LinkCandidate = {
      url,
      anchor,
      titleAttr: cleanText($(el).attr("title") ?? ""),
      heading,
      context: contextFor($, el, anchor),
      boilerplate: inBoilerplate($, el),
      nofollow: /\bnofollow\b/i.test($(el).attr("rel") ?? ""),
      source: "html",
    };
    const prev = links.get(url);
    // Keep one candidate per URL: prefer a content link over a menu link, and a real anchor.
    if (!prev || (prev.boilerplate && !candidate.boilerplate) || (!prev.anchor && candidate.anchor)) {
      links.set(url, candidate);
    }
  });

  const dataBlocks: string[] = [];
  for (const d of extractDataIslands($, base)) {
    if (d.kind === "block") dataBlocks.push(d.text);
    else if (!links.has(d.link.url) && d.link.url !== pageNorm) links.set(d.link.url, d.link);
  }

  const bodyText = cleanText(blockText($("body").get(0) ?? $.root().get(0)!));
  const visibleTextLength = bodyText.length;
  const htmlLinks = [...links.values()].filter((l) => l.source === "html").length;
  const appShell = $("[ng-version], app-root, #root:empty, #app:empty, #__next:empty").length > 0;
  const thin = visibleTextLength < 300 || (appShell && visibleTextLength < 1500) || htmlLinks < 3;

  return {
    title: cleanText($("title").first().text()),
    canonical: canonicalHref ? normalizeUrl(canonicalHref, base) : null,
    metaNofollow: /\b(nofollow|none)\b/.test(robotsMeta),
    metaNoindex: /\b(noindex|none)\b/.test(robotsMeta),
    links: [...links.values()],
    dataBlocks,
    visibleTextLength,
    thin,
  };
}

type DataItem = { kind: "block"; text: string } | { kind: "link"; link: LinkCandidate };

const URL_KEYS = /^(href|url|link|path|uri|linkurl|link_url)$/i;
const LABEL_KEYS = ["label", "title", "text", "name", "linkText", "link_text", "alt", "imageAltText", "heading"];
const IGNORED_KEYS = /^(id|uuid|key|class|classes|style|color|size|type|target|icon|image|imagesource|src|token|hash)$/i;

/**
 * Many sites ship their menus and cards as JSON inside the page and draw them with scripts.
 * Reading that JSON finds links and text that the HTML alone does not show, without a browser.
 */
function extractDataIslands($: CheerioAPI, base: string): DataItem[] {
  const out: DataItem[] = [];
  let nodes = 0;
  const isUrlish = (v: string) => /^(https?:\/\/|\/)[^\s]*$/i.test(v);
  const walk = (value: unknown, depth: number) => {
    if (depth > 14 || nodes++ > 30_000 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const v of value) walk(v, depth + 1);
      return;
    }
    const obj = value as Record<string, unknown>;
    const strings: string[] = [];
    let href: string | null = null;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v !== "string") continue;
      if (URL_KEYS.test(k) && isUrlish(v)) {
        href = v;
        continue;
      }
      if (IGNORED_KEYS.test(k) || isUrlish(v)) continue;
      const t = cleanText(v.replace(/<[^>]+>/g, " "));
      if (t.length < 2 || t.length > 300 || /^[a-z0-9_-]+$/.test(t)) continue; // skip enum-like values
      strings.push(t);
    }
    if (href) {
      const url = normalizeUrl(href, base);
      if (url) {
        const label = LABEL_KEYS.map((k) => obj[k]).find((v): v is string => typeof v === "string" && !!v.trim());
        out.push({
          kind: "link",
          link: {
            url,
            anchor: cleanText(label ?? ""),
            titleAttr: "",
            heading: "",
            context: strings.join(" · ").slice(0, 200),
            boilerplate: false,
            nofollow: false,
            source: "data",
          },
        });
      }
    }
    if (strings.length >= 2) out.push({ kind: "block", text: strings.join("\n").slice(0, 600) });
    for (const v of Object.values(obj)) if (v && typeof v === "object") walk(v, depth + 1);
  };
  $('script[type="application/json"], script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text();
    if (!raw || raw.length > 2_000_000) return;
    try {
      walk(JSON.parse(raw), 0);
    } catch {
      // not valid JSON: ignore
    }
  });
  return out;
}
