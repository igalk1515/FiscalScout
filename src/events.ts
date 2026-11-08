import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Db } from "./db/client.js";

export interface CrawlEvent {
  /** Database id, used as the SSE event id so a client can resume. Null for events not stored. */
  id: number | null;
  crawlId: string;
  type: string;
  data: Record<string, unknown>;
  at: string;
}

type Listener = (e: CrawlEvent) => void;

const CHANNEL = "crawl_events";
const MAX_NOTIFY_BYTES = 7000; // Postgres NOTIFY payloads must stay under 8000 bytes

/**
 * Crawl events: stored in crawl_events (the live view's history) and pushed to every open
 * stream. Events also go out on a Postgres NOTIFY channel, so a crawl running in another
 * process (the CLI, a second worker) still shows up live in the API's watch page.
 */
export class EventBus {
  private listeners = new Map<string, Set<Listener>>();
  private readonly origin = randomUUID();
  private listenClient: pg.PoolClient | null = null;

  constructor(private db: Db) {}

  /** Starts receiving events from other processes. */
  async listen(): Promise<void> {
    if (this.listenClient) return;
    const client = await this.db.connect();
    client.on("notification", (msg) => {
      if (msg.channel !== CHANNEL || !msg.payload) return;
      try {
        const { o, e } = JSON.parse(msg.payload) as { o: string; e: CrawlEvent & { truncated?: boolean } };
        if (o === this.origin) return; // already delivered in this process
        if (e.truncated && e.id) {
          void this.history(e.crawlId, e.id - 1, 1).then(([full]) => full && this.deliver(full));
          return;
        }
        this.deliver(e);
      } catch {
        // ignore malformed payloads
      }
    });
    client.on("error", () => {});
    await client.query(`listen ${CHANNEL}`);
    this.listenClient = client;
  }

  async close(): Promise<void> {
    if (!this.listenClient) return;
    await this.listenClient.query(`unlisten ${CHANNEL}`).catch(() => {});
    this.listenClient.release();
    this.listenClient = null;
  }

  private payload(e: CrawlEvent): string {
    const full = JSON.stringify({ o: this.origin, e });
    if (Buffer.byteLength(full) <= MAX_NOTIFY_BYTES) return full;
    return JSON.stringify({ o: this.origin, e: { ...e, data: {}, truncated: true } });
  }

  async emit(crawlId: string, type: string, data: Record<string, unknown>, persist = true): Promise<CrawlEvent> {
    let event: CrawlEvent = { id: null, crawlId, type, data, at: new Date().toISOString() };
    if (persist) {
      // One round trip: store the event, then announce it with its id.
      const r = await this.db.query<{ id: number; at: Date }>(
        "insert into crawl_events (crawl_id, type, data) values ($1, $2, $3) returning id, at",
        [crawlId, type, JSON.stringify(data)],
      );
      event = { ...event, id: r.rows[0]!.id, at: r.rows[0]!.at.toISOString() };
    }
    this.deliver(event);
    await this.db.query("select pg_notify($1, $2)", [CHANNEL, this.payload(event)]).catch(() => {});
    return event;
  }

  private deliver(event: CrawlEvent) {
    for (const fn of this.listeners.get(event.crawlId) ?? []) {
      try {
        fn(event);
      } catch {
        // a broken listener must not stop the crawl
      }
    }
  }

  subscribe(crawlId: string, fn: Listener): () => void {
    let set = this.listeners.get(crawlId);
    if (!set) this.listeners.set(crawlId, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (!set!.size) this.listeners.delete(crawlId);
    };
  }

  async history(crawlId: string, afterId = 0, limit = 2000): Promise<CrawlEvent[]> {
    const r = await this.db.query<{ id: number; type: string; data: Record<string, unknown>; at: Date }>(
      "select id, type, data, at from crawl_events where crawl_id = $1 and id > $2 order by id limit $3",
      [crawlId, afterId, limit],
    );
    return r.rows.map((row) => ({ id: row.id, crawlId, type: row.type, data: row.data, at: row.at.toISOString() }));
  }
}
