import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { fastify, type FastifyError } from "fastify";
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { type AppContext, BadRequest } from "../app.js";
import { NotFound, registerRoutes } from "./routes.js";

interface ValidationIssue {
  instancePath?: string;
  message?: string;
  params?: { issue?: { path?: (string | number)[] } };
}

/** Builds the HTTP API: validation and OpenAPI docs come from the same Zod schemas. */
export async function buildServer(ctx: AppContext) {
  const app = fastify({ logger: false, disableRequestLogging: true });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(swagger, {
    openapi: {
      info: {
        title: "High-Value Link Scraper API",
        version: "1.0.0",
        description:
          "Start crawls of public-sector websites, follow them live, and read the ranked links, documents and finance contacts they found.",
      },
      tags: [
        { name: "crawls", description: "Start and follow crawls" },
        { name: "results", description: "Ranked links and contacts" },
        { name: "system", description: "Health" },
      ],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  app.setErrorHandler((err: FastifyError, _req, reply) => {
    if (err.validation) {
      const first = err.validation[0] as ValidationIssue | undefined;
      const path = first?.params?.issue?.path?.join(".") || first?.instancePath?.replace(/^\//, "").replace(/\//g, ".");
      return reply.status(400).send({
        error: {
          code: "invalid_parameter",
          message: `${err.validationContext ?? "request"}${path ? `.${path}` : ""}: ${first?.message ?? err.message}`,
          ...(path ? { param: path } : {}),
        },
      });
    }
    const e = err as unknown;
    if (e instanceof BadRequest) {
      return reply.status(400).send({ error: { code: "invalid_parameter", message: e.message, ...(e.param ? { param: e.param } : {}) } });
    }
    if (e instanceof NotFound) return reply.status(404).send({ error: { code: "not_found", message: e.message } });
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: { code: err.code?.toLowerCase() ?? "bad_request", message: err.message } });
    }
    ctx.log.error({ err }, "request failed");
    return reply.status(500).send({ error: { code: "internal", message: "internal error" } });
  });
  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({ error: { code: "not_found", message: `no route for ${req.method} ${req.url}` } }),
  );

  registerRoutes(app, ctx);
  return app;
}
