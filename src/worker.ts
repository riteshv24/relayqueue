import { Store } from "./database.js";
import { signPayload } from "./signature.js";
import type { Config } from "./config.js";

export function retryDelay(
  attempt: number,
  base: number,
  maximum: number,
  random = Math.random,
): number {
  const exponential = Math.min(maximum, base * 2 ** Math.min(attempt - 1, 30));
  return Math.max(
    1,
    Math.min(maximum, Math.round(exponential * (0.8 + random() * 0.4))),
  );
}
export class Worker {
  private timer?: NodeJS.Timeout;
  private current?: Promise<boolean>;
  constructor(
    private store: Store,
    private project: string,
    private config: Config,
    private transport: typeof fetch = fetch,
    private clock = Date.now,
    private random = Math.random,
  ) {}
  async tick(): Promise<boolean> {
    if (this.current) return false;
    const execution = this.deliver();
    this.current = execution;
    try {
      return await execution;
    } finally {
      this.current = undefined;
    }
  }
  private async deliver(): Promise<boolean> {
    const row = this.store.claim(
      this.project,
      this.clock(),
      this.config.LEASE_MS,
    );
    if (!row) return false;
    const body = JSON.stringify({
      id: row.id,
      type: row.type,
      createdAt: new Date(row.created_at).toISOString(),
      data: JSON.parse(row.payload),
    });
    const timestamp = Math.floor(this.clock() / 1000);
    let ok = false;
    let statusCode: number | null = null;
    let error: string | null = null;
    try {
      const response = await this.transport(this.config.DESTINATION_URL, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(this.config.REQUEST_TIMEOUT_MS),
        headers: {
          "content-type": "application/json",
          "x-relay-id": row.id,
          "x-relay-attempt": String(row.total_attempts),
          "x-relay-signature": signPayload(
            body,
            this.config.WEBHOOK_SECRET,
            timestamp,
          ),
        },
        body,
      });
      statusCode = response.status;
      ok = response.ok;
      if (!ok) error = `Receiver returned HTTP ${response.status}`;
      await response.body?.cancel();
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause.message.slice(0, 500)
          : "Delivery failed";
    }
    this.store.complete(
      row,
      { ok, statusCode, error },
      this.clock(),
      ok
        ? 0
        : retryDelay(
            row.cycle_attempts,
            this.config.BASE_DELAY_MS,
            this.config.MAX_DELAY_MS,
            this.random,
          ),
    );
    return true;
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error) =>
        console.error("Worker tick failed", error),
      );
    }, this.config.WORKER_POLL_MS);
    void this.tick().catch((error) =>
      console.error("Worker tick failed", error),
    );
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.current;
  }
}
