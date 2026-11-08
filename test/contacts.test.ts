import { describe, expect, it } from "vitest";
import { extractPage, parseHtml } from "../src/crawler/extract.js";
import { cleanName, findContacts, verifyAgainstBlock } from "../src/ranking/contacts.js";
import { compileKeywords, DEFAULT_KEYWORDS } from "../src/ranking/keywords.js";
import type { LlmClient } from "../src/ranking/llm.js";
import { fixture, type FixtureName } from "./helpers/fixtures.js";

const groups = compileKeywords(DEFAULT_KEYWORDS);

async function contactsOn(name: FixtureName, domain: string, llm?: LlmClient) {
  const { html, url } = fixture(name);
  const $ = parseHtml(html);
  const page = extractPage($, url);
  return findContacts($, page.dataBlocks, { groups, entityDomain: domain, pagePathScore: 0.9, llm });
}

describe("finance contacts on the test sites (rules only)", () => {
  it("Ann Arbor: Marti Praschan, Chief Financial Officer, with email and phone", async () => {
    const [top] = await contactsOn("a2gov_finance", "a2gov.org");
    expect(top).toMatchObject({
      name: "Marti Praschan",
      title: "Chief Financial Officer",
      email: "mpraschan@a2gov.org",
      phone: "734.794.6500 x45100",
    });
  });

  it("Boerne: Wesley Scott, with the credentials kept out of the name and the email from the link", async () => {
    const [top] = await contactsOn("boerne_bfs", "boerneisd.net");
    expect(top).toMatchObject({ name: "Wesley Scott", title: "Chief Financial Officer", email: "wesley.scott@boerneisd.net" });
  });

  it("ASU: Morgan R. Olsen from the card data, with the title and no email", async () => {
    const [top] = await contactsOn("asu_cfo", "asu.edu");
    expect(top!.name).toBe("Morgan R. Olsen");
    expect(top!.title).toMatch(/Treasurer and CFO/);
    expect(top!.email).toBeNull();
  });
});

describe("names and verification", () => {
  it("cleans honorifics and credentials, rejects non-names", () => {
    expect(cleanName("Dr. Morgan R. Olsen")).toBe("Morgan R. Olsen");
    expect(cleanName("Wesley Scott, CPA, RTSBA")).toBe("Wesley Scott");
    expect(cleanName("Finance Department")).toBeNull();
    expect(cleanName("Contact Us")).toBeNull();
  });

  it("drops any value the LLM returns that is not in the block", () => {
    const block = "Marti Praschan,\nChief Financial Officer\nEmail: mpraschan@a2gov.org";
    const ok = verifyAgainstBlock(
      { name: "Marti Praschan", title: "Chief Financial Officer", email: "mpraschan@a2gov.org", phone: "734-555-0100" },
      block,
    );
    expect(ok).toEqual({ name: "Marti Praschan", title: "Chief Financial Officer", email: "mpraschan@a2gov.org", phone: null });
    expect(verifyAgainstBlock({ name: "Jane Invented", title: null, email: null, phone: null }, block)).toBeNull();
  });

  it("uses the LLM when it is on, and still verifies its answer", async () => {
    const fake: LlmClient = {
      enabled: true,
      model: "fake",
      classifyLinks: async () => [],
      extractContacts: async () => [
        { name: "Marti Praschan", title: "Chief Financial Officer", email: "invented@a2gov.org", phone: null },
      ],
    };
    const [top] = await contactsOn("a2gov_finance", "a2gov.org", fake);
    expect(top!.name).toBe("Marti Praschan");
    expect(top!.decidedBy).toBe("llm");
    expect(top!.email).toBeNull(); // the invented email is not on the page
  });
});
