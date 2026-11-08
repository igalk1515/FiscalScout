import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Pages saved from the test sites on November 7-8, 2026, with the URL each was saved from. */
export const FIXTURES = {
  a2gov_home: ["a2gov-home.html", "https://www.a2gov.org/"],
  a2gov_finance: ["a2gov-finance.html", "https://www.a2gov.org/finance-and-administrative-services/"],
  a2gov_reports: [
    "a2gov-financial-reporting.html",
    "https://www.a2gov.org/finance-and-administrative-services/financial-reporting/",
  ],
  asu_home: ["asu-home.html", "https://www.asu.edu/"],
  asu_applicant: ["asu-cfo-applicant.html", "https://cfo.asu.edu/applicant"],
  asu_cfo: ["asu-cfo-home.html", "https://cfo.asu.edu/"],
  asu_reports: ["asu-financial-reports.html", "https://cfo.asu.edu/financial-reports"],
  asu_budget: ["asu-annual-operating-budget.html", "https://cfo.asu.edu/annual-operating-budget"],
  boerne_home: ["boerne-home.html", "https://www.boerneisd.net/"],
  boerne_bfs: ["boerne-business-financial-services.html", "https://www.boerneisd.net/244573_3"],
  boerne_transparency: ["boerne-financial-transparency.html", "https://www.boerneisd.net/82152_4"],
  boerne_afr: ["boerne-annual-financial-reports.html", "https://www.boerneisd.net/82157_4"],
  boerne_budgets: ["boerne-adopted-budgets.html", "https://www.boerneisd.net/82153_4"],
  cleargov: ["cleargov-budget.html", "https://city-ann-arbor-mi-cleardoc.cleargov.com/23859/930791/d"],
} as const;

export type FixtureName = keyof typeof FIXTURES;

export function fixture(name: FixtureName): { html: string; url: string } {
  const [file, url] = FIXTURES[name];
  return { html: readFileSync(join(import.meta.dirname, "..", "fixtures", file), "utf8"), url };
}
