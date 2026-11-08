import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * Raw pages as gzip files on disk, named by URL hash. Keeping them means ranking can be rerun
 * and tested without fetching the sites again. They never go into the database.
 */
export async function saveRaw(dir: string, urlHash: Buffer, body: Buffer): Promise<string> {
  const hex = urlHash.toString("hex");
  const rel = join(hex.slice(0, 2), `${hex}.html.gz`);
  await mkdir(join(dir, hex.slice(0, 2)), { recursive: true });
  await writeFile(join(dir, rel), gzipSync(body));
  return rel;
}

export async function readRaw(dir: string, rel: string): Promise<string> {
  return gunzipSync(await readFile(join(dir, rel))).toString("utf8");
}
