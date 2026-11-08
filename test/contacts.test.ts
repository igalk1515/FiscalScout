import { describe, expect, it } from "vitest";
import { extractPage, parseHtml } from "../src/crawler/extract.js";
import { cleanName, cleanTitle, findContacts, parseContactLines, verifyAgainstBlock } from "../src/ranking/contacts.js";
import { compileKeywords, DEFAULT_KEYWORDS } from "../src/ranking/keywords.js";
import type { LlmClient } from "../src/ranking/llm.js";
import { samePerson } from "../src/store/repo.js";
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

describe("the rest of the finance office, ranked by how close the title is", () => {
  it("Boerne: the assistant director of business services, from her own page", async () => {
    const xs = await contactsOn("boerne_business_contact", "boerneisd.net");
    const ana = xs.find((c) => c.name === "Ana Webb");
    expect(ana).toMatchObject({ title: "Assistant Director of Business Services", email: "ana.webb@boerneisd.net" });
  });

  it("Boerne: the purchasing director", async () => {
    const xs = await contactsOn("boerne_purchasing", "boerneisd.net");
    expect(xs.find((c) => c.name === "Eddie Ashley")).toMatchObject({ title: "Purchasing Director", email: "eddie.ashley@boerneisd.net" });
  });

  it("Boerne: the payroll manager ranks above the payroll specialists", async () => {
    const xs = await contactsOn("boerne_payroll", "boerneisd.net");
    const manager = xs.find((c) => c.name === "Kathy Acosta")!;
    const specialist = xs.find((c) => c.name === "Kim Keckler")!;
    expect(manager).toMatchObject({ title: "Payroll Manager", email: "kathy.acosta@boerneisd.net" });
    expect(specialist.title).toBe("Payroll Specialist");
    expect(manager.score).toBeGreaterThan(specialist.score);
  });

  it("the CFO ranks above everyone in the office, and a department name alone is not a title", async () => {
    const [cfo] = await contactsOn("boerne_bfs", "boerneisd.net");
    const payroll = await contactsOn("boerne_payroll", "boerneisd.net");
    const purchasing = await contactsOn("boerne_purchasing", "boerneisd.net");
    for (const c of [...payroll, ...purchasing]) expect(c.score).toBeLessThan(cfo!.score);
    expect([...payroll, ...purchasing].some((c) => /^(payroll|purchasing)$/i.test(c.title ?? ""))).toBe(false);
  });

  it("an office name is not a title, a department mailbox is not a person's email, a former CFO ranks low", async () => {
    const one = async (block: string) => {
      const $ = parseHtml(`<html><body><div>${block}</div></body></html>`);
      return findContacts($, [], { groups, entityDomain: "a2gov.org", pagePathScore: 0.9 });
    };
    expect(await one("<p>Marlen Uribe</p><p>BA in political science, Office of the State Treasurer</p>")).toHaveLength(0);
    const [treasurer] = await one('<p>Michael Pettigrew</p><p>City Treasurer</p><p><a href="mailto:customerservice@a2gov.org">Customer service</a></p>');
    expect(treasurer).toMatchObject({ name: "Michael Pettigrew", email: null });
    const [former] = await one("<p>Mary Hentges</p><p>Former Chief Financial Officer</p>");
    const [current] = await one("<p>Morgan Olsen</p><p>Chief Financial Officer</p>");
    expect(former!.score).toBeLessThan(current!.score * 0.5);
  });

  it("keeps only a real email: a hidden one ('[email protected]') stays hidden", () => {
    const block = "Veronica Robles\nDeputy Chief Procurement Officer\n[email protected]";
    const got = verifyAgainstBlock({ name: "Veronica Robles", title: "Deputy Chief Procurement Officer", email: "[email protected]", phone: null }, block);
    expect(got?.email).toBeNull();
  });

  it("knows a short first name is the same person, but not a different title or last name", () => {
    expect(samePerson({ name: "Wes Scott", title: "Chief Financial Officer" }, { name: "Wesley Scott", title: "Chief Financial Officer" })).toBe(true);
    expect(samePerson({ name: "Wes Scott", title: null }, { name: "Wesley Scott", title: "Chief Financial Officer" })).toBe(true);
    expect(samePerson({ name: "Dan Smith", title: "Payroll Clerk" }, { name: "Daniel Smith", title: "Finance Director" })).toBe(false);
    expect(samePerson({ name: "Jo Smith", title: null }, { name: "John Smith", title: null })).toBe(false);
    expect(samePerson({ name: "Wesley Scott", title: null }, { name: "Wesley Scotts", title: null })).toBe(false);
  });

  it("a contact group without nearby titles keeps only its own titles", async () => {
    const strict = compileKeywords({ "finance director": { ...DEFAULT_KEYWORDS["finance director"]!, related: [] } });
    const { html, url } = fixture("boerne_payroll");
    const $ = parseHtml(html);
    const xs = await findContacts($, extractPage($, url).dataBlocks, { groups: strict, entityDomain: "boerneisd.net", pagePathScore: 0.9 });
    expect(xs).toHaveLength(0);
  });
});

describe("names and verification", () => {
  it("cleans honorifics and credentials, rejects non-names", () => {
    expect(cleanName("Dr. Morgan R. Olsen")).toBe("Morgan R. Olsen");
    expect(cleanName("Wesley Scott, CPA, RTSBA")).toBe("Wesley Scott");
    expect(cleanName("Finance Department")).toBeNull();
    expect(cleanName("Contact Us")).toBeNull();
    expect(cleanName("ASU Research Park")).toBeNull();
    expect(cleanName("Learning Enterprise")).toBeNull();
  });

  it("cleans a title taken from a sentence", () => {
    expect(cleanTitle("is the vice president for Financial Services and the deputy treasurer.&nbsp; Maryanne Patterson", "Anjali Halabe")).toBe(
      "vice president for Financial Services and the deputy treasurer",
    );
  });

  it("reads the person after a label, not the name on the line above", () => {
    expect(parseContactLines("Craig Hupy\nPrepared by: Tom Crawford, CFO", groups)).toEqual([{ name: "Tom Crawford", title: "CFO" }]);
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
