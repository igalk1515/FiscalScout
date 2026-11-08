import { buildServer } from "./api/server.js";
import { createContext } from "./app.js";

const ctx = await createContext();
const app = await buildServer(ctx);
await app.listen({ port: ctx.config.PORT, host: ctx.config.HOST });
ctx.log.info(
  { port: ctx.config.PORT, llm: ctx.llm.enabled ? ctx.llm.model : "off (no OPENAI_API_KEY)" },
  `API on http://localhost:${ctx.config.PORT} · docs at /docs`,
);
await ctx.runner.resume(); // continue crawls interrupted by a restart

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    ctx.log.info({ signal }, "shutting down");
    await app.close();
    await ctx.close();
    process.exit(0);
  });
}
