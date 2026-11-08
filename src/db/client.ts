import pg from "pg";

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;

// int8 (bigserial ids, counts) comes back as a string by default. Our ids stay far below
// 2^53, so numbers are safe and much easier to work with.
pg.types.setTypeParser(20, (v) => Number(v));
// numeric (cost in dollars) as a number too.
pg.types.setTypeParser(1700, (v) => Number(v));

export function createDb(connectionString: string, max = 10): Db {
  return new pg.Pool({ connectionString, max });
}

/** Runs fn inside a transaction and returns its result. */
export async function tx<T>(db: Db, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
