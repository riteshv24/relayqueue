import { createServer, type Server } from "node:http";
import { verifySignature } from "./signature.js";
import type { Config } from "./config.js";

/** Demo receiver state is intentionally in memory; a real consumer must persist deduplication. */
export async function startReceiver(config: Config): Promise<Server> {
  const counts = new Map<string, number>();
  const accepted = new Set<string>();
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/health" && request.method === "GET") {
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (request.url !== "/webhook" || request.method !== "POST") {
      response.writeHead(404).end("{}");
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let body = "";
    try {
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 65536) {
          response.writeHead(413).end("{}");
          return;
        }
        chunks.push(buffer);
      }
      body = Buffer.concat(chunks).toString("utf8");
      const signature = request.headers["x-relay-signature"];
      if (
        typeof signature !== "string" ||
        !verifySignature(body, signature, config.WEBHOOK_SECRET)
      ) {
        response
          .writeHead(401)
          .end(JSON.stringify({ error: "Invalid or expired signature" }));
        return;
      }
      const event = JSON.parse(body) as {
        id?: unknown;
        data?: { alwaysFail?: unknown };
      };
      if (typeof event.id !== "string") {
        response.writeHead(400).end("{}");
        return;
      }
      if (accepted.has(event.id)) {
        response.end(JSON.stringify({ accepted: true, duplicate: true }));
        return;
      }
      const count = (counts.get(event.id) ?? 0) + 1;
      counts.set(event.id, count);
      if (event.data?.alwaysFail === true || count <= config.DEMO_FAIL_FIRST) {
        console.log(`Demo receiver: ${event.id} attempt ${count} -> 503`);
        response
          .writeHead(503)
          .end(JSON.stringify({ error: "Simulated temporary failure" }));
        return;
      }
      accepted.add(event.id);
      console.log(
        `Demo receiver: ${event.id} attempt ${count} -> 200 (signature verified)`,
      );
      response.end(JSON.stringify({ accepted: true }));
    } catch {
      response.writeHead(400).end(JSON.stringify({ error: "Invalid request" }));
    }
  });
  server.requestTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.RECEIVER_PORT, config.HOST, resolve);
  });
  return server;
}
