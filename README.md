# RelayQueue

A durable webhook delivery service with a live operations dashboard. Submit an event once, inspect every delivery attempt, and recover failed deliveries without losing their history.

Built with TypeScript, Fastify, SQLite, and Node.js 24. The application runs locally without paid services or external API keys.

![RelayQueue dashboard showing two failed attempts followed by successful delivery](docs/dashboard.png)

## The problem

Webhooks fail when receivers are slow, offline, or temporarily overloaded. Retrying inside an HTTP request makes the caller wait, while storing retries only in memory loses work on restart. RelayQueue persists events before accepting them and delivers them asynchronously with a bounded retry policy.

## What it demonstrates

- REST API design with strict validation, pagination, and consistent errors.
- Transactional SQL, durable idempotency, and tenant-scoped API key authorization.
- Background processing with exponential backoff, jitter, leases, and stale-worker fencing.
- HMAC-signed outgoing requests and timestamp validation at the receiver.
- A dashboard for queue counts, attempt history, event submission, and dead-letter replay.
- Integration tests, Docker packaging, and GitHub Actions CI.

## Quick start

Install **Node.js 24 LTS**, then run from this directory:

```bash
npm ci
npm run demo
```

Open **http://localhost:3000** and connect with the development API key:

```text
rq_demo_change_me_32_characters_minimum
```

The demo starts the API, background worker, dashboard, and a local webhook receiver. No separate database installation is needed. SQLite writes to `data/relayqueue.db`.

1. Create a demo event in the dashboard.
2. Watch the first two delivery attempts fail with HTTP 503.
3. The third attempt succeeds after the retry delays.
4. Select an event to inspect its payload and persisted attempt history.

To try dead-letter recovery, create an event with `maxAttempts: 2`. After two failures it becomes `dead`. Replay it; the receiver accepts the third lifetime attempt. Attempt history remains intact.

The demo receiver keeps its simulation counters in memory. Restarting it resets those counters; the queue and attempt history remain in SQLite.

## Stack

| Layer             | Implementation                                                  |
| ----------------- | --------------------------------------------------------------- |
| Runtime           | Node.js 24 with built-in `node:sqlite`                          |
| API               | Fastify and Zod, written in TypeScript                          |
| Persistence       | SQLite WAL, SQL transactions, scoped unique constraints         |
| Worker            | Persistent retry scheduling and expiring leases                 |
| Authentication    | Per-project Bearer API key, SHA-256 hash stored in the database |
| Delivery security | SHA-256 HMAC over timestamp and exact body bytes                |
| Dashboard         | Responsive HTML, CSS, and JavaScript served by the API          |
| Tests             | Node.js test runner and Fastify request injection               |
| Delivery          | Docker Compose and GitHub Actions                               |

## How delivery works

```mermaid
flowchart TD
    A[Client or dashboard] --> B[Authenticated event API]
    B --> C[(SQLite events and attempts)]
    C --> D[Lease-based worker]
    D --> E[Signed webhook request]
    E --> F{Receiver response}
    F -->|2xx| G[Succeeded]
    F -->|Failure or timeout| H{Retry budget}
    H -->|Available| I[Schedule with backoff]
    I --> C
    H -->|Exhausted| J[Dead letter]
    J -->|Manual replay| C
```

Event creation and idempotency checks occur in a transaction. A worker claims a due event with a new lease token and creates an in-flight attempt. It sends the webhook outside the transaction, then records the result only if it still owns that token. Expired leases are reclaimable after a crash.

This is **at-least-once delivery**, not exactly-once processing. A receiver may process a request before the worker crashes or loses the response. Receivers must deduplicate using the stable event ID. Hash signatures verify authenticity; they do not replace durable receiver deduplication.

## Configuration

Copy `.env.example` to `.env` to override defaults. The npm commands load `.env` automatically.

| Variable             | Default                              | Purpose                                   |
| -------------------- | ------------------------------------ | ----------------------------------------- |
| `HOST`               | `127.0.0.1`                          | API and demo receiver bind address        |
| `PORT`               | `3000`                               | API and dashboard port                    |
| `DATABASE_PATH`      | `data/relayqueue.db`                 | Persistent database file                  |
| `PROJECT_NAME`       | `demo`                               | Project served by this process            |
| `API_KEY`            | Development key shown above          | API authentication, minimum 32 characters |
| `WEBHOOK_SECRET`     | Development secret in `.env.example` | Signing secret, minimum 32 characters     |
| `DESTINATION_URL`    | `http://127.0.0.1:4001/webhook`      | Operator-configured receiver              |
| `BASE_DELAY_MS`      | `1000`                               | Initial retry delay                       |
| `MAX_DELAY_MS`       | `60000`                              | Maximum retry delay                       |
| `LEASE_MS`           | `15000`                              | Worker lease duration                     |
| `REQUEST_TIMEOUT_MS` | `5000`                               | Delivery timeout                          |
| `WORKER_POLL_MS`     | `250`                                | Queue polling interval                    |
| `RECEIVER_PORT`      | `4001`                               | Demo receiver port                        |
| `DEMO_FAIL_FIRST`    | `2`                                  | Simulated failures per event              |

The retry base is `min(maxDelay, baseDelay × 2^(attempt - 1))`. The final delay is `min(maxDelay, retryBase × jitter)`, where jitter ranges from 0.8 to 1.2. All failed responses, including 4xx, are retried up to the configured event budget. HTTP redirects are refused.

Delivery destinations are configured at startup. Clients cannot submit arbitrary URLs. For a real integration, set `DESTINATION_URL`, generate unique API and signing secrets, and run:

```bash
npm run build
npm start
```

`npm start` does not start the demo receiver. The worker still runs in the API process. Production mode rejects the provided demo secrets. Use HTTPS and an access-controlled reverse proxy when deploying beyond localhost.

## API

All `/api/` routes require `Authorization: Bearer <API_KEY>`. The dashboard sends this header and stores its key only in the current browser session.

| Method | Endpoint                 | Purpose                                                |
| ------ | ------------------------ | ------------------------------------------------------ |
| `GET`  | `/health`                | Process liveness; does not probe receiver availability |
| `POST` | `/api/events`            | Persist an event; requires `Idempotency-Key`           |
| `GET`  | `/api/events`            | List events; supports `status`, `page`, and `pageSize` |
| `GET`  | `/api/events/:id`        | Event detail and attempt history                       |
| `POST` | `/api/events/:id/replay` | Reset the retry budget of a dead-letter event          |
| `GET`  | `/api/stats`             | Project queue counts                                   |

New events return `202`. Repeating the same idempotency key and equivalent JSON returns the existing event with `200`. Reusing a key with different event data returns `409`. Keys are scoped by project and remain valid while their event exists.

Example using Bash or Git Bash:

```bash
curl -X POST http://localhost:3000/api/events \
  -H 'Authorization: Bearer rq_demo_change_me_32_characters_minimum' \
  -H 'Idempotency-Key: example-build-001' \
  -H 'Content-Type: application/json' \
  -d '{"type":"build.completed","payload":{"branch":"main","commit":"a1b2c3d","status":"passed"},"maxAttempts":5}'
```

The request accepts only `type`, object `payload`, and optional `maxAttempts` (1–10; default 5). Maximum request size is 64 KiB. Use a new idempotency key for each distinct event.

```bash
curl http://localhost:3000/api/events?status=succeeded \
  -H 'Authorization: Bearer rq_demo_change_me_32_characters_minimum'
```

Outgoing requests include:

- `X-Relay-Id`: stable event ID for receiver deduplication.
- `X-Relay-Attempt`: lifetime attempt number, including manual replays.
- `X-Relay-Signature`: `t=<unix_seconds>,v1=<hex_hmac>` over `<timestamp>.<raw_body>`.

The included receiver rejects signatures more than five minutes in the past or future. See [`src/signature.ts`](src/signature.ts) for signing and verification.

## Run with Docker

```bash
docker compose up --build
```

The dashboard is available at http://localhost:3000. The named volume preserves events across container restarts. The image runs as a non-root user and includes a health check. Docker builds execute the test suite before producing the runtime image.

```bash
docker compose down
```

This stops the application and preserves data. `docker compose down -v` also deletes the demo database; only use it when you want a clean reset.

## Tests and CI

```bash
npm test
npm run format:check
```

The automated suite checks:

- Tampered, stale, future-dated, and invalid HMAC signatures.
- Idempotency and event persistence across closing and reopening SQLite.
- Conflicting payloads and API validation failures.
- Authentication and cross-project read/replay isolation.
- Lease exclusivity, crash recovery, and rejection of stale completions.
- Retry timing, bounded jitter, network failures, and successful recovery.
- Exhausted retry budgets, dead-letter replay, and retained history.

GitHub Actions runs a clean install, TypeScript build, tests, production dependency audit, and Docker image build. Local verification passed all 13 automated tests and the TypeScript build. Browser checks covered connecting, creating an event, two failed attempts followed by success, attempt history, and desktop/390px mobile layouts. Docker execution was not verified locally; the included CI job builds and tests the image after you push.

## Repository layout

| Path                      | Responsibility                                               |
| ------------------------- | ------------------------------------------------------------ |
| `src/app.ts`              | API routes, validation, authentication, static asset serving |
| `src/database.ts`         | Schema, idempotency transactions, leases, attempts, queries  |
| `src/worker.ts`           | Delivery, timeout, retry scheduling                          |
| `src/signature.ts`        | HMAC and canonical JSON                                      |
| `src/receiver.ts`         | Deterministic local failure demo and signature verification  |
| `src/config.ts`           | Environment validation                                       |
| `src/main.ts`             | Startup and graceful shutdown                                |
| `public/`                 | Operations dashboard                                         |
| `test/relayqueue.test.ts` | Automated behavior and integration tests                     |

## Design boundaries

This is a runnable portfolio implementation with explicit limits:

- SQLite and the single-process worker suit a small, single-node deployment. Network-mounted databases and distributed multi-region operation are outside scope.
- Each process provisions one project and polls only that project's queue. Multiple processes sharing a local database must use consistent project names, keys, destinations, and signing secrets.
- One delivery runs at a time per process. This is intentionally bounded; no throughput benchmark is claimed.
- The event database is durable, but cannot prevent data loss from a lost disk. Backups and retention policies are not implemented.
- API keys are high-entropy shared credentials rather than user accounts. Per-user roles, key-management UI, and rate limiting are future work.
- No external monitoring or alerting is configured. The dashboard and persisted attempts provide local operational visibility.
- The demo receiver deduplicates in memory. A real receiver should persist its deduplication records.

For a code-reading path and design discussions, see [the interview guide](docs/INTERVIEW_GUIDE.md).

## License

MIT. See [LICENSE](LICENSE).

## Pull requests and releases

Changes are checked by GitHub Actions before release. See [the release guide](docs/RELEASING.md) for PR checks, required repository settings, tested container images, and deployment setup.
