import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDb, type Db } from "./client.js";

const here = dirname(fileURLToPath(import.meta.url));
// src/db and dist/db both sit two levels below the project root.
export const MIGRATIONS_DIR = resolve(here, "../../migrations");

/**
 * Applies every migrations/*.sql file that has not run yet, in name order, each in its own
 * transaction. An advisory lock keeps two processes from migrating at the same time.
 */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query("select pg_advisory_lock(727274)");
    await client.query(
      "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const done = await client.query("select 1 from schema_migrations where name = $1", [file]);
      if (done.rowCount) continue;
      const sql = await readFile(join(dir, file), "utf8");
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [file]);
        await client.query("commit");
        applied.push(file);
      } catch (err) {
        await client.query("rollback");
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock(727274)").catch(() => {});
    client.release();
  }
  return applied;
}

// CLI: npm run migrate
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { config } = await import("../config.js");
  const db = createDb(config.DATABASE_URL, 1);
  try {
    const applied = await migrate(db);
    console.log(applied.length ? `applied: ${applied.join(", ")}` : "schema is up to date");
    const tables = await db.query(
      "select table_name from information_schema.tables where table_schema = 'public' order by 1",
    );
    console.log("tables:", tables.rows.map((r) => r.table_name).join(", "));
  } finally {
    await db.end();
  }
}
