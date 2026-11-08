import { createHash } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db/client.js";
import type { CompiledGroup } from "./keywords.js";

export const LINK_PROMPT_VERSION = "links-1";
export const CONTACT_PROMPT_VERSION = "contacts-1";

// Price per million tokens, for the cost shown in the live view. Configurable because prices change.
const PRICE_IN = Number(process.env.LLM_PRICE_IN_PER_M ?? 0.15);
const PRICE_OUT = Number(process.env.LLM_PRICE_OUT_PER_M ?? 0.6);

export interface LlmLinkInput {
  i: number;
  url: string;
  anchor: string;
  heading: string;
  context: string;
}
export interface LlmLinkResult {
  i: number;
  doc_type: string | null;
  target_score: number;
  path_score: number;
  reason: string;
}
export interface LlmContact {
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
}
export interface CallInfo {
  cached: boolean;
  costUsd: number;
}

export interface LlmClient {
  enabled: boolean;
  model: string;
  classifyLinks(items: LlmLinkInput[], groups: CompiledGroup[], onCall?: (c: CallInfo) => void): Promise<LlmLinkResult[] | null>;
  extractContacts(block: string, onCall?: (c: CallInfo) => void): Promise<LlmContact[] | null>;
}

export interface LlmCache {
  get(key: Buffer): Promise<unknown | undefined>;
  set(key: Buffer, model: string, promptVersion: string, value: unknown): Promise<void>;
}

export function memoryCache(): LlmCache {
  const m = new Map<string, unknown>();
  return {
    get: async (k) => m.get(k.toString("hex")),
    set: async (k, _model, _v, value) => void m.set(k.toString("hex"), value),
  };
}

export function dbCache(db: Db): LlmCache {
  return {
    async get(key) {
      const r = await db.query("select response from llm_cache where key = $1", [key]);
      return r.rows[0]?.response;
    },
    async set(key, model, promptVersion, value) {
      await db.query(
        "insert into llm_cache (key, model, prompt_version, response) values ($1, $2, $3, $4) on conflict (key) do nothing",
        [key, model, promptVersion, JSON.stringify(value)],
      );
    },
  };
}

const LinkResults = z.object({
  items: z.array(
    z.object({
      i: z.number().int(),
      doc_type: z.string().nullable(),
      target_score: z.number(),
      path_score: z.number(),
      reason: z.string(),
    }),
  ),
});
const ContactResults = z.object({
  contacts: z.array(
    z.object({ name: z.string(), title: z.string().nullable(), email: z.string().nullable(), phone: z.string().nullable() }),
  ),
});

const LINK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["i", "doc_type", "target_score", "path_score", "reason"],
        properties: {
          i: { type: "integer" },
          doc_type: { type: ["string", "null"] },
          target_score: { type: "number" },
          path_score: { type: "number" },
          reason: { type: "string" },
        },
      },
    },
  },
};
const CONTACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["contacts"],
  properties: {
    contacts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "title", "email", "phone"],
        properties: {
          name: { type: "string" },
          title: { type: ["string", "null"] },
          email: { type: ["string", "null"] },
          phone: { type: ["string", "null"] },
        },
      },
    },
  },
};

function linkSystemPrompt(groups: CompiledGroup[]): string {
  const targets = groups.map((g) => `- "${g.key}" (${g.kind}): ${g.terms.join(", ")}`).join("\n");
  return `You label links found on public-sector websites: cities, counties, school districts and universities.
The targets are:
${targets}

For each link, decide:
- doc_type: the target the link itself IS (the document, or the page about that person), using one of the names above exactly, or null.
- target_score: from 0 to 1, how likely the link itself is that target.
- path_score: from 0 to 1, how likely following the link reaches targets within two clicks.
- reason: one short sentence.
Use the link text, the heading above it, the nearby text and the URL. A page that lists budgets is a path, not a target.
A draft or an old year is still the target, with a lower score. Return one item per input link, with the same "i".`;
}

const CONTACT_SYSTEM = `You read a short block of text from a public-sector website and list the people in it.
For each person return name (without honorifics like Dr. or Mr., and without credentials like CPA),
title, email and phone, copied exactly as they appear in the text. Use null for anything that is not there.
Never guess an email or a phone number. Return an empty list if the block names nobody.`;

interface Options {
  apiKey?: string;
  model: string;
  baseUrl: string;
  cache: LlmCache;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onError?: (message: string) => void;
}

/**
 * The LLM tier. It sees short link records or one small text block, never a whole page.
 * Every answer is validated against a schema and cached by input; any failure returns null,
 * and the caller keeps the rules result.
 */
export function createLlm(opts: Options): LlmClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const enabled = !!opts.apiKey;

  async function call<T>(
    promptVersion: string,
    system: string,
    input: unknown,
    schemaName: string,
    schema: object,
    parser: z.ZodType<T>,
    onCall?: (c: CallInfo) => void,
  ): Promise<T | null> {
    if (!enabled) return null;
    const payload = JSON.stringify(input);
    const key = createHash("sha256").update(`${opts.model}\n${promptVersion}\n${system}\n${payload}`).digest();
    const hit = await opts.cache.get(key).catch(() => undefined);
    if (hit !== undefined) {
      const parsed = parser.safeParse(hit);
      if (parsed.success) {
        onCall?.({ cached: true, costUsd: 0 });
        return parsed.data;
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
    try {
      const res = await doFetch(`${opts.baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({
          model: opts.model,
          temperature: 0,
          messages: [
            { role: "system", content: system },
            { role: "user", content: payload },
          ],
          response_format: { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } },
        }),
      });
      if (!res.ok) {
        opts.onError?.(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return null;
      }
      const body = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const content = body.choices?.[0]?.message?.content;
      if (!content) return null;
      const parsed = parser.safeParse(JSON.parse(content));
      if (!parsed.success) {
        opts.onError?.(`LLM answer failed validation: ${parsed.error.message.slice(0, 200)}`);
        return null;
      }
      const cost =
        ((body.usage?.prompt_tokens ?? 0) * PRICE_IN + (body.usage?.completion_tokens ?? 0) * PRICE_OUT) / 1_000_000;
      onCall?.({ cached: false, costUsd: cost });
      await opts.cache.set(key, opts.model, promptVersion, parsed.data).catch(() => {});
      return parsed.data;
    } catch (err) {
      opts.onError?.(`LLM call failed: ${(err as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    enabled,
    model: opts.model,
    async classifyLinks(items, groups, onCall) {
      if (!items.length) return [];
      const out = await call(LINK_PROMPT_VERSION, linkSystemPrompt(groups), { links: items }, "link_labels", LINK_SCHEMA, LinkResults, onCall);
      if (!out) return null;
      const keys = new Set(groups.map((g) => g.key));
      const ids = new Set(items.map((x) => x.i));
      const clamp = (n: number) => Math.max(0, Math.min(1, n));
      return out.items
        .filter((x) => ids.has(x.i))
        .map((x) => ({
          ...x,
          doc_type: x.doc_type && keys.has(x.doc_type) ? x.doc_type : null,
          target_score: clamp(x.target_score),
          path_score: clamp(x.path_score),
        }));
    },
    async extractContacts(block, onCall) {
      const out = await call(CONTACT_PROMPT_VERSION, CONTACT_SYSTEM, { text: block }, "contacts", CONTACT_SCHEMA, ContactResults, onCall);
      return out ? out.contacts : null;
    },
  };
}
