import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** A tiny local web server for tests. Routes are matched on path plus query string. */
export async function startServer(routes: Record<string, Handler>) {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const path = req.url ?? "/";
    hits.push(path);
    const handler = routes[path] ?? routes[path.split("?")[0]!];
    if (!handler) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<html><body>not found</body></html>");
      return;
    }
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export const html = (body: string, status = 200): Handler => (_req, res) => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`);
};

export const text = (body: string, status = 200, type = "text/plain"): Handler => (_req, res) => {
  res.writeHead(status, { "content-type": type });
  res.end(body);
};

export const redirect = (to: string, status = 301): Handler => (_req, res) => {
  res.writeHead(status, { location: to });
  res.end();
};
