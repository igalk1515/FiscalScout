import { createRequire } from "node:module";
import { fetchUrl } from "./fetcher.js";

interface Robot {
  isAllowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
  getSitemaps(): string[];
}
// robots-parser is CommonJS and its type file declares an ES default export, which TypeScript's
// NodeNext mode cannot call. Loading it with require gives the real function.
const robotsParser = createRequire(import.meta.url)("robots-parser") as (url: string, text: string) => Robot;

/**
 * What robots.txt tells us for one host, following RFC 9309:
 * - 2xx: parse the rules.
 * - 4xx (including 401 and 403): the file is "unavailable", so everything is allowed.
 * - 5xx or a network error: the file is "unreachable", so everything is disallowed.
 */
export type RobotsPolicy =
  | { kind: "allow_all"; status: number }
  | { kind: "disallow_all"; status: number }
  | { kind: "rules"; status: number; robot: Robot };

export const ROBOTS_MAX_BYTES = 500 * 1024; // RFC 9309: parse at least 500 KiB

export function policyFromResponse(robotsUrl: string, status: number, body: string | null): RobotsPolicy {
  if (status >= 200 && status < 300) {
    const text = (body ?? "").slice(0, ROBOTS_MAX_BYTES);
    return { kind: "rules", status, robot: robotsParser(robotsUrl, text) };
  }
  if (status >= 400 && status < 500) return { kind: "allow_all", status };
  return { kind: "disallow_all", status }; // 5xx, or 0 for a network error
}

export function isAllowed(policy: RobotsPolicy, url: string, token: string): boolean {
  if (policy.kind === "allow_all") return true;
  if (policy.kind === "disallow_all") return false;
  // robots-parser returns undefined for a URL on another origin; we only ask about our own host.
  return policy.robot.isAllowed(url, token) !== false;
}

export function crawlDelayMs(policy: RobotsPolicy, token: string): number | undefined {
  if (policy.kind !== "rules") return undefined;
  const seconds = policy.robot.getCrawlDelay(token);
  return typeof seconds === "number" && seconds > 0 ? Math.min(seconds, 60) * 1000 : undefined;
}

export function robotsUrlFor(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}/robots.txt`;
}

export interface RobotsFetch {
  policy: RobotsPolicy;
  status: number;
  text: string | null;
}

/** Fetches /robots.txt for the URL's host (up to five redirects, 500 KiB) and turns it into a policy. */
export async function fetchRobots(anyUrl: string, userAgent: string): Promise<RobotsFetch> {
  const robotsUrl = robotsUrlFor(anyUrl);
  const r = await fetchUrl(robotsUrl, {
    userAgent,
    timeoutMs: 10_000,
    maxBytes: ROBOTS_MAX_BYTES,
    readBody: "any",
    accept: "text/plain,*/*;q=0.5",
  });
  const text = r.body ? r.body.toString("utf8") : null;
  return { policy: policyFromResponse(robotsUrl, r.status, text), status: r.status, text };
}

export function describePolicy(policy: RobotsPolicy): string {
  if (policy.kind === "rules") return `rules (robots.txt ${policy.status})`;
  if (policy.kind === "allow_all") return `allow all (robots.txt ${policy.status}, RFC 9309: 4xx means no rules)`;
  return `disallow all (robots.txt ${policy.status || "unreachable"}, RFC 9309: 5xx or no answer)`;
}
