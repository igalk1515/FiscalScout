import { createDb, type Db } from "../../src/db/client.js";
import { migrate } from "../../src/db/migrate.js";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://scraper:scraper@localhost:5433/scraper_test";

/** A migrated, empty test database. */
export async function testDb(): Promise<Db> {
  const db = createDb(TEST_DATABASE_URL, 10);
  await migrate(db);
  await db.query(
    "truncate crawl_events, contacts, sightings, link_scores, links, pages, frontier, hosts, sites, crawls, llm_cache restart identity cascade",
  );
  return db;
}

export const silentLog = { info: () => {}, warn: () => {}, error: () => {} };
