import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, ConflictError } from "../src/database.js";
import { signPayload, verifySignature } from "../src/signature.js";
import { retryDelay, Worker } from "../src/worker.js";
import { readConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { startReceiver } from "../src/receiver.js";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

const key = "rq_test_secret_32_characters_minimum";
const config = readConfig({
  NODE_ENV: "test",
  API_KEY: key,
  BASE_DELAY_MS: "100",
  MAX_DELAY_MS: "1000",
});
const input = {
  type: "build.completed",
  payload: { branch: "main", status: "passed" },
  maxAttempts: 3,
};
function setup() {
  const store = new Store(":memory:");
  const project = store.ensureProject("test", key);
  return { store, project };
}

test("HMAC verifies exact bytes and rejects tampering, wrong secrets, and stale/future timestamps", () => {
  const body = '{"id":"event-1","data":{"ok":true}}';
  const signature = signPayload(body, config.WEBHOOK_SECRET, 1000);
  assert.equal(
    verifySignature(body, signature, config.WEBHOOK_SECRET, 1000),
    true,
  );
  assert.equal(
    verifySignature(body + " ", signature, config.WEBHOOK_SECRET, 1000),
    false,
  );
  assert.equal(
    verifySignature(body, signature, "different-secret", 1000),
    false,
  );
  assert.equal(
    verifySignature(body, signature, config.WEBHOOK_SECRET, 1301),
    false,
  );
  assert.equal(
    verifySignature(body, signature, config.WEBHOOK_SECRET, 699),
    false,
  );
  assert.equal(
    verifySignature(body, "not-a-signature", config.WEBHOOK_SECRET, 1000),
    false,
  );
});

test("idempotency survives restart, canonicalizes object keys, and rejects changed payloads", () => {
  const directory = mkdtempSync(join(tmpdir(), "relayqueue-test-"));
  const path = join(directory, "queue.db");
  let store = new Store(path);
  try {
    const project = store.ensureProject("test", key);
    const first = store.create(project, "same-key", input, 1000);
    store.close();
    store = new Store(path);
    const again = store.create(
      project,
      "same-key",
      { ...input, payload: { status: "passed", branch: "main" } },
      2000,
    );
    assert.equal(again.event.id, first.event.id);
    assert.equal(again.replayed, true);
    assert.equal(store.list(project, undefined, 1, 20).total, 1);
    assert.throws(
      () =>
        store.create(project, "same-key", {
          ...input,
          payload: { branch: "other" },
        }),
      ConflictError,
    );
    assert.equal(store.authenticate(key), project);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("leased events cannot be double claimed; crashed worker is reclaimed and stale completion fenced", () => {
  const { store, project } = setup();
  try {
    const created = store.create(project, "lease", input, 1000);
    const old = store.claim(project, 1000, 1000)!;
    assert.equal(old.id, created.event.id);
    assert.equal(store.claim(project, 1500, 1000), undefined);
    const renewed = store.claim(project, 2001, 1000)!;
    assert.equal(renewed.id, old.id);
    assert.notEqual(renewed.lease_token, old.lease_token);
    assert.equal(renewed.cycle_attempts, 2);
    assert.equal(
      store.complete(old, { ok: true, statusCode: 200, error: null }, 2002, 0),
      false,
    );
    assert.equal(store.event(project, old.id).status, "processing");
    assert.equal(
      store.complete(
        renewed,
        { ok: true, statusCode: 200, error: null },
        2003,
        0,
      ),
      true,
    );
    const attempts = store.attempts(project, old.id);
    assert.equal(attempts[1].outcome, "interrupted");
    assert.equal(attempts[0].outcome, "succeeded");
  } finally {
    store.close();
  }
});

test("separate SQLite connections enforce a single lease for the same event", () => {
  const directory = mkdtempSync(join(tmpdir(), "relayqueue-concurrency-"));
  const path = join(directory, "queue.db");
  const first = new Store(path),
    second = new Store(path);
  try {
    const project = first.ensureProject("test", key);
    first.create(project, "lease", input, 1);
    assert.ok(first.claim(project, 1, 1000));
    assert.equal(second.claim(project, 1, 1000), undefined);
  } finally {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a crash on the final attempt becomes dead-letter after lease expiry", () => {
  const { store, project } = setup();
  try {
    const { event } = store.create(
      project,
      "last",
      { ...input, maxAttempts: 1 },
      1,
    );
    store.claim(project, 1, 1000);
    assert.equal(store.claim(project, 1002, 1000), undefined);
    assert.equal(store.event(project, event.id).status, "dead");
    assert.equal(store.attempts(project, event.id)[0].outcome, "interrupted");
  } finally {
    store.close();
  }
});

test("worker retries 503 responses with signed stable event body and succeeds on third attempt", async () => {
  const { store, project } = setup();
  let now = 1000;
  let requests = 0;
  const bodies: string[] = [];
  const transport = (async (_url, options) => {
    requests++;
    const body = String(options?.body);
    bodies.push(body);
    const headers = options?.headers as Record<string, string>;
    assert.equal(
      verifySignature(
        body,
        headers["x-relay-signature"],
        config.WEBHOOK_SECRET,
        Math.floor(now / 1000),
      ),
      true,
    );
    assert.equal(options?.redirect, "error");
    return new Response("{}", { status: requests < 3 ? 503 : 200 });
  }) as typeof fetch;
  const worker = new Worker(
    store,
    project,
    config,
    transport,
    () => now,
    () => 0.5,
  );
  try {
    const { event } = store.create(project, "retry", input, now);
    assert.equal(await worker.tick(), true);
    assert.equal(store.event(project, event.id).next_attempt_at, 1100);
    assert.equal(await worker.tick(), false);
    now = 1100;
    await worker.tick();
    assert.equal(store.event(project, event.id).next_attempt_at, 1300);
    now = 1300;
    await worker.tick();
    assert.equal(store.event(project, event.id).status, "succeeded");
    assert.equal(requests, 3);
    assert.equal(new Set(bodies).size, 1);
    assert.equal(store.attempts(project, event.id).length, 3);
  } finally {
    store.close();
  }
});

test("permanent failure reaches dead-letter; manual replay preserves history and resets retry budget", async () => {
  const { store, project } = setup();
  let now = 1000;
  const worker = new Worker(
    store,
    project,
    config,
    (async () => new Response("{}", { status: 500 })) as typeof fetch,
    () => now,
    () => 0.5,
  );
  try {
    const { event } = store.create(
      project,
      "dead",
      { ...input, maxAttempts: 2 },
      now,
    );
    await worker.tick();
    now += 100;
    await worker.tick();
    assert.equal(store.event(project, event.id).status, "dead");
    const replay = store.replay(project, event.id, now);
    assert.equal(replay.status, "pending");
    assert.equal(replay.cycleAttempts, 0);
    assert.equal(replay.totalAttempts, 2);
    assert.equal(store.attempts(project, event.id).length, 2);
    assert.throws(() => store.replay(project, event.id, now), ConflictError);
    await worker.tick();
    assert.equal(store.event(project, event.id).total_attempts, 3);
  } finally {
    store.close();
  }
});

test("network errors are recorded and retried without losing the event", async () => {
  const { store, project } = setup();
  try {
    const { event } = store.create(project, "network", input, 1000);
    const worker = new Worker(
      store,
      project,
      config,
      (async () => {
        throw new Error("Connection refused");
      }) as typeof fetch,
      () => 1000,
      () => 0.5,
    );
    await worker.tick();
    assert.equal(store.event(project, event.id).status, "pending");
    assert.equal(
      store.event(project, event.id).last_error,
      "Connection refused",
    );
    assert.equal(store.attempts(project, event.id)[0].statusCode, null);
  } finally {
    store.close();
  }
});

test("backoff jitter stays within bounds and caps at the configured maximum", () => {
  assert.equal(
    retryDelay(1, 100, 1000, () => 0),
    80,
  );
  assert.equal(
    retryDelay(1, 100, 1000, () => 1),
    120,
  );
  assert.equal(
    retryDelay(2, 100, 1000, () => 0.5),
    200,
  );
  assert.equal(
    retryDelay(99, 100, 1000, () => 1),
    1000,
  );
});

test("API enforces authentication, validation, durable idempotency, and tenant isolation", async () => {
  const { store, project } = setup();
  const app = createApp(store);
  const otherKey = "rq_other_secret_32_characters_minimum";
  store.ensureProject("other", otherKey);
  const headers = {
    authorization: `Bearer ${key}`,
    "idempotency-key": "api-demo",
  };
  try {
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/events" })).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/api/events",
          headers: { authorization: "Bearer bad" },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/events",
          headers,
          payload: { ...input, destination: "http://bad" },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/events",
          headers: { authorization: `Bearer ${key}` },
          payload: input,
        })
      ).statusCode,
      400,
    );
    const first = await app.inject({
      method: "POST",
      url: "/api/events",
      headers,
      payload: input,
    });
    assert.equal(first.statusCode, 202);
    const id = first.json().event.id as string;
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/events",
          headers,
          payload: input,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/events",
          headers,
          payload: { ...input, type: "other" },
        })
      ).statusCode,
      409,
    );
    const otherHeaders = { authorization: `Bearer ${otherKey}` };
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/api/events/${id}`,
          headers: otherHeaders,
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/events/${id}/replay`,
          headers: otherHeaders,
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/api/events",
          headers: otherHeaders,
        })
      ).json().total,
      0,
    );
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/events?page=0", headers }))
        .statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/events/${id}/replay`,
          headers,
        })
      ).statusCode,
      409,
    );
    assert.equal(store.stats(project).pending, 1);
  } finally {
    await app.close();
    store.close();
  }
});

test("production refuses public demo secrets and config rejects unsafe destination formats", () => {
  assert.throws(() => readConfig({ NODE_ENV: "production" }), /unique/);
  assert.throws(
    () => readConfig({ DESTINATION_URL: "file:///etc/passwd" }),
    /HTTP/,
  );
  assert.throws(
    () =>
      readConfig({ DESTINATION_URL: "http://user:password@localhost/webhook" }),
    /credentials/,
  );
  assert.throws(
    () => readConfig({ LEASE_MS: "1000", REQUEST_TIMEOUT_MS: "5000" }),
    /LEASE/,
  );
});

test("receiver verifies UTF-8 payloads even when a character spans network chunks", async () => {
  const server = await startReceiver({
    ...config,
    RECEIVER_PORT: 0,
    DEMO_FAIL_FIRST: 0,
  });
  try {
    const body = JSON.stringify({
      id: "unicode-event",
      data: { message: "Build completed ✓ 🚀" },
    });
    const raw = Buffer.from(body);
    const split = raw.indexOf(Buffer.from("🚀")) + 1;
    const signature = signPayload(
      body,
      config.WEBHOOK_SECRET,
      Math.floor(Date.now() / 1000),
    );
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port: (server.address() as AddressInfo).port,
          path: "/webhook",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-relay-signature": signature,
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.write(raw.subarray(0, split));
      setTimeout(() => req.end(raw.subarray(split)), 10);
    });
    assert.equal(status, 200);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("a completion arriving after lease expiry is rejected even before another worker reclaims it", () => {
  const { store, project } = setup();
  try {
    const { event } = store.create(project, "late-completion", input, 1);
    const expired = store.claim(project, 1, 1000)!;
    assert.equal(
      store.complete(
        expired,
        { ok: true, statusCode: 200, error: null },
        1002,
        0,
      ),
      false,
    );
    assert.equal(store.event(project, event.id).status, "processing");
    assert.ok(store.claim(project, 1002, 1000));
    assert.equal(store.attempts(project, event.id)[1].outcome, "interrupted");
  } finally {
    store.close();
  }
});
