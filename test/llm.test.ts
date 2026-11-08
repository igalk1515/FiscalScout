import { describe, expect, it } from "vitest";
import { compileKeywords, DEFAULT_KEYWORDS } from "../src/ranking/keywords.js";
import { createLlm, memoryCache } from "../src/ranking/llm.js";

const groups = compileKeywords(DEFAULT_KEYWORDS);
const items = [{ i: 0, url: "https://x.gov/docs/view/12", anchor: "View", heading: "Adopted Budget", context: "" }];

function fakeFetch(content: unknown, status = 200) {
  const calls: unknown[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } }),
      { status, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("LLM tier", () => {
  it("is off without an API key, and then never calls out", async () => {
    const f = fakeFetch({ items: [] });
    const llm = createLlm({ model: "m", baseUrl: "https://api", cache: memoryCache(), fetchImpl: f.impl });
    expect(llm.enabled).toBe(false);
    expect(await llm.classifyLinks(items, groups)).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  it("asks for a strict JSON schema, validates the answer and caches it", async () => {
    const f = fakeFetch({ items: [{ i: 0, doc_type: "budget", target_score: 0.9, path_score: 0.1, reason: "heading says budget" }] });
    const llm = createLlm({ apiKey: "k", model: "m", baseUrl: "https://api", cache: memoryCache(), fetchImpl: f.impl });
    const costs: number[] = [];
    const first = await llm.classifyLinks(items, groups, (c) => costs.push(c.costUsd));
    expect(first).toEqual([{ i: 0, doc_type: "budget", target_score: 0.9, path_score: 0.1, reason: "heading says budget" }]);
    const body = f.calls[0] as { response_format: { type: string; json_schema: { strict: boolean } } };
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(costs[0]).toBeCloseTo((1000 * 0.15 + 100 * 0.6) / 1e6);
    await llm.classifyLinks(items, groups, (c) => costs.push(c.costUsd));
    expect(f.calls).toHaveLength(1); // the second answer came from the cache
    expect(costs[1]).toBe(0);
  });

  it("returns null on a bad answer, so the rules score stays", async () => {
    const llm = createLlm({ apiKey: "k", model: "m", baseUrl: "https://api", cache: memoryCache(), fetchImpl: fakeFetch({ wrong: true }).impl });
    expect(await llm.classifyLinks(items, groups)).toBeNull();
    const down = createLlm({ apiKey: "k", model: "m", baseUrl: "https://api", cache: memoryCache(), fetchImpl: fakeFetch({}, 500).impl });
    expect(await down.classifyLinks(items, groups)).toBeNull();
  });

  it("drops unknown document types and clamps scores", async () => {
    const f = fakeFetch({ items: [{ i: 0, doc_type: "pizza", target_score: 3, path_score: -1, reason: "?" }] });
    const llm = createLlm({ apiKey: "k", model: "m", baseUrl: "https://api", cache: memoryCache(), fetchImpl: f.impl });
    const [r] = (await llm.classifyLinks(items, groups))!;
    expect(r).toMatchObject({ doc_type: null, target_score: 1, path_score: 0 });
  });
});
