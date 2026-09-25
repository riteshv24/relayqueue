import Fastify from "fastify";
import { z, ZodError } from "zod";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ConflictError,
  NotFoundError,
  publicEvent,
  Store,
} from "./database.js";

const eventSchema = z
  .object({
    type: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-zA-Z0-9._-]+$/),
    payload: z.record(z.string(), z.json()),
    maxAttempts: z.number().int().min(1).max(10).default(5),
  })
  .strict();
const querySchema = z
  .object({
    status: z.enum(["pending", "processing", "succeeded", "dead"]).optional(),
    page: z.coerce.number().int().min(1).max(1000000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
const keySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9._:-]+$/);
const uuidSchema = z.uuid();

declare module "fastify" {
  interface FastifyRequest {
    projectId: string;
  }
}
export function createApp(store: Store, publicDirectory = resolve("public")) {
  const app = Fastify({
    logger: false,
    bodyLimit: 65536,
    requestTimeout: 10000,
    connectionTimeout: 10000,
  });
  app.decorateRequest("projectId", "");
  app.addHook("onRequest", async (request, reply) => {
    reply
      .header("x-content-type-options", "nosniff")
      .header("x-frame-options", "DENY")
      .header("referrer-policy", "no-referrer");
    reply.header(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    if (request.url.startsWith("/api/")) {
      reply.header("cache-control", "no-store");
      const value = request.headers.authorization;
      const match = value && /^Bearer (\S{32,512})$/.exec(value);
      const project = match && store.authenticate(match[1]);
      if (!project)
        return reply.code(401).send({
          error: "Unauthorized",
          message: "A valid Bearer API key is required",
        });
      request.projectId = project;
    }
  });
  app.setErrorHandler((error, request, reply) => {
    void request;
    if (error instanceof ZodError)
      return reply.code(400).send({
        error: "Invalid request",
        details: error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    if (error instanceof ConflictError)
      return reply
        .code(409)
        .send({ error: "Conflict", message: error.message });
    if (error instanceof NotFoundError)
      return reply
        .code(404)
        .send({ error: "Not found", message: error.message });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500)
      return reply
        .code(status)
        .send({ error: "Invalid request", message: (error as Error).message });
    console.error("Request error", error);
    return reply.code(500).send({ error: "Internal server error" });
  });
  app.get("/health", async () => ({ status: "ok", service: "relayqueue" }));
  app.get("/api/stats", async (request) => store.stats(request.projectId));
  app.get("/api/events", async (request) => {
    const q = querySchema.parse(request.query);
    return store.list(request.projectId, q.status, q.page, q.pageSize);
  });
  app.post("/api/events", async (request, reply) => {
    const key = keySchema.parse(request.headers["idempotency-key"]);
    const body = eventSchema.parse(request.body);
    const result = store.create(request.projectId, key, body);
    return reply.code(result.replayed ? 200 : 202).send(result);
  });
  app.get("/api/events/:id", async (request) => {
    const id = uuidSchema.parse((request.params as { id: string }).id);
    return {
      event: publicEvent(store.event(request.projectId, id)),
      attempts: store.attempts(request.projectId, id),
    };
  });
  app.post("/api/events/:id/replay", async (request) => {
    const id = uuidSchema.parse((request.params as { id: string }).id);
    return { event: store.replay(request.projectId, id) };
  });
  // Serve a fixed asset map; user paths can never traverse the filesystem.
  for (const [route, file, mime] of [
    ["/", "index.html", "text/html; charset=utf-8"],
    ["/styles.css", "styles.css", "text/css; charset=utf-8"],
    ["/app.js", "app.js", "text/javascript; charset=utf-8"],
  ]) {
    app.get(route, async (_request, reply) =>
      reply.type(mime).send(readFileSync(resolve(publicDirectory, file))),
    );
  }
  return app;
}
