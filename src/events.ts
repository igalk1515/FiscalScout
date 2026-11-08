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

/**
 * Crawl events: stored in crawl_events (the live view's history) and pushed to every open
 * stream. The crawler runs in the API process, so delivery is in memory.
 */
export class EventBus {
  private listeners = new Map<string, Set<Listener>>();

  constructor(private db: Db) {}

  async emit(crawlId: string, type: string, data: Record<string, unknown>, persist = true): Promise<CrawlEvent> {
    let event: CrawlEvent = { id: null, crawlId, type, data, at: new Date().toISOString() };
    if (persist) {
      const r = await this.db.query<{ id: number; at: Date }>(
        "insert into crawl_events (crawl_id, type, data) values ($1, $2, $3) returning id, at",
        [crawlId, type, JSON.stringify(data)],
      );
      event = { ...event, id: r.rows[0]!.id, at: r.rows[0]!.at.toISOString() };
    }
    for (const fn of this.listeners.get(crawlId) ?? []) {
      try {
        fn(event);
      } catch {
        // a broken listener must not stop the crawl
      }
    }
    return event;
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
