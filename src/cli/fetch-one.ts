// Step 2 check: fetch each URL politely and print what came back.
// Usage: npm run fetch-one -- [url ...]   (defaults to the four test sites)
import { robotsToken, userAgent } from "../config.js";
import { fetchUrl } from "../crawler/fetcher.js";
import { describePolicy, fetchRobots, isAllowed } from "../crawler/robots.js";
import { TEST_SITES } from "./test-sites.js";

const urls = process.argv.slice(2).length ? process.argv.slice(2) : TEST_SITES.map((s) => s.seed);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log(`User-Agent: ${userAgent}\n`);
for (const url of urls) {
  const robots = await fetchRobots(url, userAgent);
  const allowed = isAllowed(robots.policy, url, robotsToken);
  console.log(url);
  console.log(`  robots:   ${describePolicy(robots.policy)} -> ${allowed ? "allowed" : "disallowed"}`);
  if (!allowed) {
    console.log("  page:     not fetched\n");
    continue;
  }
  await sleep(1000); // one request at a time per host, a second apart
  const r = await fetchUrl(url, { userAgent });
  const blocked = [401, 403, 429].includes(r.status) ? "  <- blocked" : "";
  console.log(`  status:   ${r.status || "no response"}${blocked}${r.error ? ` (${r.error})` : ""}`);
  console.log(`  final:    ${r.finalUrl}${r.redirects.length ? `  (${r.redirects.length} redirect${r.redirects.length > 1 ? "s" : ""})` : ""}`);
  console.log(`  type:     ${r.contentType ?? "-"}`);
  console.log(`  size:     ${r.bytes.toLocaleString()} bytes${r.truncated ? " (truncated)" : ""}`);
  console.log(`  time:     ${r.ms} ms\n`);
}
