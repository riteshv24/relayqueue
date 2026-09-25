import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson } from "./signature.js";

export type EventStatus = "pending" | "processing" | "succeeded" | "dead";
export interface EventRow {
  id: string;
  project_id: string;
  idempotency_key: string;
  request_hash: string;
  type: string;
  payload: string;
  status: EventStatus;
  cycle_attempts: number;
  total_attempts: number;
  max_attempts: number;
  next_attempt_at: number;
  lease_until: number | null;
  lease_token: string | null;
  created_at: number;
  updated_at: number;
  last_error: string | null;
}
interface ProjectRow {
  id: string;
  name: string;
  key_hash: string;
}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}
export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
export function publicEvent(row: EventRow) {
  return {
    id: row.id,
    type: row.type,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    status: row.status,
    cycleAttempts: row.cycle_attempts,
    totalAttempts: row.total_attempts,
    maxAttempts: row.max_attempts,
    nextAttemptAt: new Date(row.next_attempt_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    lastError: row.last_error,
  };
}
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, key_hash TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS events(
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','processing','succeeded','dead')),
        cycle_attempts INTEGER NOT NULL DEFAULT 0, total_attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL,
        next_attempt_at INTEGER NOT NULL, lease_until INTEGER, lease_token TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_error TEXT,
        UNIQUE(project_id,idempotency_key));
      CREATE INDEX IF NOT EXISTS events_due ON events(project_id,status,next_attempt_at,lease_until);
      CREATE TABLE IF NOT EXISTS attempts(
        id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL REFERENCES events(id), attempt_number INTEGER NOT NULL,
        lease_token TEXT NOT NULL UNIQUE, outcome TEXT NOT NULL, status_code INTEGER, error TEXT,
        started_at INTEGER NOT NULL, finished_at INTEGER, duration_ms INTEGER);
      PRAGMA user_version=1;`);
  }
  close() {
    this.db.close();
  }
  ensureProject(name: string, key: string): string {
    const existing = this.db
      .prepare("SELECT * FROM projects WHERE name=?")
      .get(name) as unknown as ProjectRow | undefined;
    if (existing) {
      this.db
        .prepare("UPDATE projects SET key_hash=? WHERE id=?")
        .run(hashKey(key), existing.id);
      return existing.id;
    }
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO projects(id,name,key_hash) VALUES(?,?,?)")
      .run(id, name, hashKey(key));
    return id;
  }
  authenticate(key: string): string | undefined {
    return (
      this.db
        .prepare("SELECT id FROM projects WHERE key_hash=?")
        .get(hashKey(key)) as { id: string } | undefined
    )?.id;
  }
  event(project: string, id: string): EventRow {
    const row = this.db
      .prepare("SELECT * FROM events WHERE project_id=? AND id=?")
      .get(project, id) as unknown as EventRow | undefined;
    if (!row) throw new NotFoundError("Event not found");
    return row;
  }
  create(
    project: string,
    key: string,
    data: {
      type: string;
      payload: Record<string, unknown>;
      maxAttempts: number;
    },
    now = Date.now(),
  ) {
    const requestHash = hashKey(canonicalJson(data));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare(
          "SELECT * FROM events WHERE project_id=? AND idempotency_key=?",
        )
        .get(project, key) as unknown as EventRow | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash)
          throw new ConflictError(
            "Idempotency key already belongs to a different request",
          );
        this.db.exec("COMMIT");
        return { event: publicEvent(existing), replayed: true };
      }
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO events(id,project_id,idempotency_key,request_hash,type,payload,status,max_attempts,next_attempt_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'pending',?,?,?,?)`,
        )
        .run(
          id,
          project,
          key,
          requestHash,
          data.type,
          canonicalJson(data.payload),
          data.maxAttempts,
          now,
          now,
          now,
        );
      const row = this.event(project, id);
      this.db.exec("COMMIT");
      return { event: publicEvent(row), replayed: false };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  list(
    project: string,
    status: EventStatus | undefined,
    page: number,
    pageSize: number,
  ) {
    const where = status ? "project_id=? AND status=?" : "project_id=?";
    const args = status ? [project, status] : [project];
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS count FROM events WHERE ${where}`)
        .get(...args) as { count: number }
    ).count;
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, pageSize, (page - 1) * pageSize) as unknown as EventRow[];
    return { events: rows.map(publicEvent), total, page, pageSize };
  }
  stats(project: string) {
    const result = { pending: 0, processing: 0, succeeded: 0, dead: 0 };
    const rows = this.db
      .prepare(
        "SELECT status,COUNT(*) AS count FROM events WHERE project_id=? GROUP BY status",
      )
      .all(project) as unknown as { status: EventStatus; count: number }[];
    for (const row of rows) result[row.status] = row.count;
    return result;
  }
  attempts(project: string, id: string) {
    this.event(project, id);
    const rows = this.db
      .prepare("SELECT * FROM attempts WHERE event_id=? ORDER BY id DESC")
      .all(id) as unknown as {
      id: number;
      attempt_number: number;
      outcome: string;
      status_code: number | null;
      error: string | null;
      started_at: number;
      finished_at: number | null;
      duration_ms: number | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      attemptNumber: row.attempt_number,
      outcome: row.outcome,
      statusCode: row.status_code,
      error: row.error,
      startedAt: new Date(row.started_at).toISOString(),
      finishedAt:
        row.finished_at === null
          ? null
          : new Date(row.finished_at).toISOString(),
      durationMs: row.duration_ms,
    }));
  }
  replay(project: string, id: string, now = Date.now()) {
    const result = this.db
      .prepare(
        `UPDATE events SET status='pending',cycle_attempts=0,next_attempt_at=?,updated_at=?,last_error=NULL,lease_until=NULL,lease_token=NULL WHERE project_id=? AND id=? AND status='dead'`,
      )
      .run(now, now, project, id);
    if (!result.changes) {
      this.event(project, id);
      throw new ConflictError("Only dead-letter events can be replayed");
    }
    return publicEvent(this.event(project, id));
  }
  claim(project: string, now: number, leaseMs: number): EventRow | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // A worker that crashed during its final allowed attempt still consumes the attempt.
      this.db
        .prepare(
          `UPDATE attempts SET outcome='interrupted',error='Worker lease expired',finished_at=?,duration_ms=?-started_at WHERE outcome='in_flight' AND event_id IN (SELECT id FROM events WHERE project_id=? AND status='processing' AND lease_until<=?)`,
        )
        .run(now, now, project, now);
      this.db
        .prepare(
          `UPDATE events SET status='dead',last_error='Worker lease expired after final attempt',lease_token=NULL,lease_until=NULL,updated_at=? WHERE project_id=? AND status='processing' AND lease_until<=? AND cycle_attempts>=max_attempts`,
        )
        .run(now, project, now);
      const row = this.db
        .prepare(
          `SELECT * FROM events WHERE project_id=? AND cycle_attempts<max_attempts AND ((status='pending' AND next_attempt_at<=?) OR (status='processing' AND lease_until<=?)) ORDER BY next_attempt_at,created_at,id LIMIT 1`,
        )
        .get(project, now, now) as unknown as EventRow | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return undefined;
      }
      const token = randomUUID();
      this.db
        .prepare(
          `UPDATE events SET status='processing',lease_token=?,lease_until=?,cycle_attempts=cycle_attempts+1,total_attempts=total_attempts+1,updated_at=? WHERE id=?`,
        )
        .run(token, now + leaseMs, now, row.id);
      this.db
        .prepare(
          `INSERT INTO attempts(event_id,attempt_number,lease_token,outcome,started_at) VALUES(?,?,?,'in_flight',?)`,
        )
        .run(row.id, row.total_attempts + 1, token, now);
      const claimed = this.event(project, row.id);
      this.db.exec("COMMIT");
      return claimed;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  complete(
    row: EventRow,
    outcome: { ok: boolean; statusCode: number | null; error: string | null },
    now: number,
    delayMs: number,
  ): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const status = outcome.ok
        ? "succeeded"
        : row.cycle_attempts >= row.max_attempts
          ? "dead"
          : "pending";
      const result = this.db
        .prepare(
          `UPDATE events SET status=?,last_error=?,next_attempt_at=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='processing' AND lease_token=? AND lease_until>?`,
        )
        .run(
          status,
          outcome.error,
          now + delayMs,
          now,
          row.id,
          row.lease_token,
          now,
        );
      if (result.changes)
        this.db
          .prepare(
            `UPDATE attempts SET outcome=?,status_code=?,error=?,finished_at=?,duration_ms=?-started_at WHERE lease_token=? AND outcome='in_flight'`,
          )
          .run(
            outcome.ok ? "succeeded" : "failed",
            outcome.statusCode,
            outcome.error,
            now,
            now,
            row.lease_token,
          );
      this.db.exec("COMMIT");
      return Boolean(result.changes);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
