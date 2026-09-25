# RelayQueue: code walkthrough and interview notes

Use this guide to understand the implementation and reproduce its behavior before discussing the project. Describe only work you understand and can explain; the repository is a portfolio implementation, not evidence of production operation.

## Read the code in this order

1. **`src/main.ts` and `src/config.ts`** — Follow startup: validate environment variables, open SQLite, provision the configured project, create the API, and start the worker. Notice the relationship between request timeout and lease duration.
2. **`src/app.ts`** — Trace `POST /api/events`. Authentication resolves a project from a hashed API key; Zod validates the request and the idempotency header; the store persists the event before returning `202`.
3. **`src/database.ts`** — Read `create`, `claim`, and `complete`. These methods define the important transaction boundaries, scoped unique constraint, lease token, retry budget, and attempt history.
4. **`src/worker.ts`** — Follow one delivery outside the database transaction: serialize the event, sign the body, make a bounded HTTP request, and persist success or the next retry time.
5. **`src/signature.ts` and `src/receiver.ts`** — Compare signing with verification. The receiver checks exact body bytes and timestamp freshness, then simulates two failures before accepting the event.
6. **`public/app.js` and `test/relayqueue.test.ts`** — See how the dashboard consumes the API and how tests exercise duplicate submissions, tenant isolation, failures, and lease recovery.

## Five design discussions

### 1. Why use SQLite instead of a hosted queue or PostgreSQL?

SQLite makes the project reproducible with one Node.js installation while still providing real SQL transactions, unique constraints, and disk persistence. WAL mode allows readers to operate alongside a writer, and `BEGIN IMMEDIATE` protects the write transactions that decide whether to create or claim an event.

The tradeoff is deployment scope. SQLite serializes writers and is intended here for a small service on one machine with a local disk. This implementation does not demonstrate a distributed queue, multi-region availability, or measured high throughput. A larger deployment could use PostgreSQL with appropriate row-level claiming, or a managed queue, while retaining event IDs and receiver deduplication.

**Show in code:** the database constructor, `Store.create`, and `Store.claim`.

### 2. What does idempotency guarantee, and what does it not guarantee?

A project and idempotency key identify one submitted event. The transaction checks for an existing record and compares a hash of canonical JSON. Equivalent object key ordering produces the same hash. The same key and request return the original event; the same key with changed data returns `409`.

This protects event creation from duplicate submissions. It does not make webhook processing exactly once. If a receiver processes a request and the worker crashes before recording success, the event can be delivered again. The outgoing event ID stays stable so the receiver can deduplicate it. The demo receiver does that only in memory; a real integration needs durable deduplication at the receiver.

**Show in code:** `canonicalJson`, `Store.create`, and the `X-Relay-Id` header in `Worker.deliver`.

### 3. How does the service recover when a worker crashes?

Claiming an event records a lease expiration, a unique token, and an in-flight attempt in one transaction. After expiration, another claim marks the previous attempt interrupted and can acquire the event with a new token. Completing an attempt requires both the current token and an unexpired lease, so a delayed worker cannot overwrite a newer result.

A crash still consumes an attempt because the service cannot know whether the receiver processed the request. If the final permitted attempt crashes, the event moves to the dead-letter state after its lease expires. The implementation processes one delivery at a time per worker process, and the configured HTTP timeout must be shorter than the lease.

**Show in code:** `Store.claim`, `Store.complete`, and the expired-lease regression tests.

### 4. How are retries bounded, and what happens after repeated failure?

Each event has a retry budget. The worker uses exponential backoff with bounded jitter and an overall delay cap. Scheduled retries are stored in SQLite, so restarting the process does not erase their due times. Failures are recorded with the HTTP status or network error.

After the budget is exhausted, the event becomes `dead`. Manual replay resets that event's retry budget but retains its ID, payload, total attempt count, and attempt history. This implementation retries all non-2xx responses; distinguishing permanent 4xx failures and respecting `Retry-After` would be useful extensions. It does not claim that every receiver error is transient.

**Show in code:** `retryDelay`, `Worker.deliver`, and `Store.replay`.

### 5. What security boundaries are present, and what would a deployment still need?

API requests require a per-project Bearer key. Only its SHA-256 hash is stored, and event reads and replay operations are scoped to the authenticated project. Payload validation rejects unexpected fields, including client-selected destinations. The receiver URL is operator-controlled, and redirects are refused.

Outgoing webhooks use HMAC-SHA256 over the timestamp and exact body bytes. Verification uses a constant-time digest comparison and a five-minute clock tolerance. That authenticates requests but does not encrypt them or prevent replay within the allowed window; HTTPS and persistent event deduplication remain necessary.

Before a broader deployment, I would add rate limiting, managed secret rotation, operational alerts, backup and retention policies, and an authenticated administration interface. This project currently uses shared project keys, not per-user accounts or role-based permissions.

**Show in code:** the authentication hook, tenant-scoped SQL queries, `verifySignature`, and `readConfig`.

## Reproduce the behavior before an interview

```bash
npm ci
npm test
npm run demo
```

Open the dashboard and connect using the documented development key. Create one event with the default retry budget and inspect its two failed attempts followed by success. Create another with a budget of two, wait for dead-letter status, then replay it and inspect the retained history. Stop and restart the demo to confirm that events and attempt records persist.

The automated tests provide additional evidence for edge cases that are awkward to demonstrate manually, including conflicting idempotency requests, cross-project access attempts, and stale worker completions. Cite those behaviors rather than inventing user counts, latency figures, availability claims, or production deployment experience.
