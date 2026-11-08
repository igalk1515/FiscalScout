import type { IncomingMessage, ServerResponse } from "node:http";
import { html, redirect, startServer, text } from "./server.js";

/**
 * A small fake city website with the problems a crawler meets: robots.txt rules, a calendar
 * trap, a repeating path, a redirect, a flaky page, a missing page, an opaque document URL,
 * social links and a finance page with an ACFR, a budget and a contact.
 */
export async function startCitySite() {
  let active = 0;
  let maxActive = 0;
  let flakyHits = 0;
  const track =
    (h: (req: IncomingMessage, res: ServerResponse) => void, delayMs = 20) =>
    (req: IncomingMessage, res: ServerResponse) => {
      active++;
      maxActive = Math.max(maxActive, active);
      setTimeout(() => {
        res.on("finish", () => active--);
        h(req, res);
      }, delayMs);
    };

  const site = await startServer({
    "/robots.txt": track(text("User-agent: *\nDisallow: /private\n")),
    "/": track(
      html(`
      <nav><a href="/departments">Departments</a> <a href="/finance">Finance</a> <a href="/news">News</a></nav>
      <main>
        <h1>Welcome to the City</h1>
        <a href="https://www.facebook.com/thecity">Facebook</a>
        <a href="/meetings/calendar?month=2031-04">Meeting schedule</a>
        <a href="/private/budget-drafts">Budget drafts</a>
        <a href="/a/b/a/b/a/b">Loop</a>
        <a href="/old-finance">Old finance page</a>
        <a href="/flaky">Transparency</a>
        <a href="/missing">Budget archive</a>
      </main>`),
    ),
    "/departments": track(html(`<h1>Departments</h1><a href="/finance">Finance Department</a>`)),
    "/finance": track(
      html(`
      <h1>Finance Department</h1>
      <h2>Annual Comprehensive Financial Report (ACFR)</h2>
      <ul>
        <li><a href="/docs/city-acfr-2025.pdf">Fiscal Year 2025</a></li>
        <li><a href="/docs/city-acfr-2024.pdf">Fiscal Year 2024</a></li>
      </ul>
      <h2>Budget</h2>
      <a href="/docs/fy2026-adopted-budget.pdf">FY2026 Adopted Budget</a>
      <a href="/DocumentCenter/View/77">Budget in Brief FY2026</a>
      <div class="staff"><p>Jane Doe,<br>Finance Director</p><p><a href="mailto:jdoe@example.gov">Email Jane</a></p></div>
      <a href="/finance/reports">Financial Reports</a>`),
    ),
    "/old-finance": track(redirect("/finance/reports")),
    "/finance/reports": track(html(`<h1>Financial Reports</h1><a href="/finance">Back</a> <a href="/poverty">Poverty Exemptions</a>`)),
    "/poverty": track(html(`<h1>Poverty Exemptions</h1><p>Forms.</p><a href="/">Home</a><a href="/finance">Finance</a>`)),
    "/flaky": track((req, res) => {
      flakyHits++;
      if (flakyHits === 1) {
        res.writeHead(503, { "content-type": "text/html", "retry-after": "0" });
        res.end("busy");
        return;
      }
      html(`<h1>Transparency</h1><a href="/finance">Finance</a>`)(req, res);
    }),
    "/DocumentCenter/View/77": track(text("%PDF-1.4 budget in brief", 200, "application/pdf")),
  });
  return { ...site, maxActive: () => maxActive, flakyHits: () => flakyHits };
}
