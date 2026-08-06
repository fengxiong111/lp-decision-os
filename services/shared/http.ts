import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

type SqliteModule = typeof import("node:sqlite");
type ThrottleDatabase = InstanceType<SqliteModule["DatabaseSync"]>;

function loadSqlite(): SqliteModule | null {
  const builtinModuleLoader = (process as NodeJS.Process & { getBuiltinModule?: (moduleId: string) => unknown }).getBuiltinModule;
  return (builtinModuleLoader?.("node:sqlite") as SqliteModule | undefined) ?? null;
}

let throttleDatabase: ThrottleDatabase | null = null;
let throttleDatabaseError = false;

function getThrottleDatabase(): ThrottleDatabase | null {
  if (throttleDatabase || throttleDatabaseError) return throttleDatabase;
  try {
    const localEventDbPath = path.join(process.cwd(), ".local-data", "lp-events.sqlite");
    const eventDbPath = process.env.LP_EVENT_DB_PATH ?? (existsSync(localEventDbPath) ? localEventDbPath : path.join(process.cwd(), "db", "lp-events.sqlite"));
    const throttlePath = process.env.LP_RPC_RATE_DB_PATH ?? path.join(path.dirname(eventDbPath), "rpc-governor.sqlite");
    mkdirSync(path.dirname(throttlePath), { recursive: true });
    const sqlite = loadSqlite();
    if (!sqlite?.DatabaseSync) throw new Error("node:sqlite 不可用");
    throttleDatabase = new sqlite.DatabaseSync(throttlePath);
    throttleDatabase.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS http_rate_schedule (rate_key TEXT PRIMARY KEY, next_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS http_rate_leases (lease_id TEXT PRIMARY KEY, acquired_at INTEGER NOT NULL);
    `);
    return throttleDatabase;
  } catch {
    throttleDatabaseError = true;
    return null;
  }
}

function sharedMethodInterval(rateKey: string): number {
  return rateKey === "rpc:getTransaction" ? Math.ceil(1_000 / 3)
    : rateKey === "rpc:getSignaturesForAddress" ? 1_000
      : 0;
}

function sharedLeaseId(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function acquireSharedHttpLease(rateKey: string, rateCost: number): Promise<() => void> {
  const db = getThrottleDatabase();
  if (!db) return () => undefined;
  const methodInterval = sharedMethodInterval(rateKey);
  while (true) {
    let waitMs = 25;
    let granted = false;
    const leaseId = sharedLeaseId();
    try {
      db.exec("BEGIN IMMEDIATE");
      const now = Date.now();
      db.prepare("DELETE FROM http_rate_leases WHERE acquired_at < ?").run(now - 60_000);
      const active = db.prepare("SELECT COUNT(*) AS count FROM http_rate_leases").get() as { count?: number };
      const global = db.prepare("SELECT next_at FROM http_rate_schedule WHERE rate_key = ?").get("global") as { next_at?: number } | undefined;
      const method = methodInterval > 0 ? db.prepare("SELECT next_at FROM http_rate_schedule WHERE rate_key = ?").get(rateKey) as { next_at?: number } | undefined : undefined;
      const nextAt = Math.max(global?.next_at ?? 0, method?.next_at ?? 0);
      if ((active.count ?? 0) < MAX_HTTP_CONCURRENCY && nextAt <= now) {
        db.prepare("INSERT OR REPLACE INTO http_rate_schedule (rate_key, next_at) VALUES (?, ?)").run("global", now + GLOBAL_INTERVAL_MS * Math.max(1, rateCost));
        if (methodInterval > 0) db.prepare("INSERT OR REPLACE INTO http_rate_schedule (rate_key, next_at) VALUES (?, ?)").run(rateKey, now + methodInterval * Math.max(1, rateCost));
        db.prepare("INSERT INTO http_rate_leases (lease_id, acquired_at) VALUES (?, ?)").run(leaseId, now);
        granted = true;
      } else {
        waitMs = Math.max(25, nextAt > now ? nextAt - now : 25);
      }
      db.exec("COMMIT");
    } catch {
      try { db.exec("ROLLBACK"); } catch { /* 锁竞争时下一轮重试 */ }
      await sleep(50);
      continue;
    }
    if (granted) {
      return () => {
        try {
          db.exec("BEGIN IMMEDIATE");
          db.prepare("DELETE FROM http_rate_leases WHERE lease_id = ?").run(leaseId);
          db.exec("COMMIT");
        } catch {
          try { db.exec("ROLLBACK"); } catch { /* 释放失败由过期清理兜底 */ }
        }
      };
    }
    await sleep(waitMs);
  }
}

export type HttpMeta = {
  url: string;
  status: number | null;
  latencyMs: number | null;
  fetchedAt: string;
  error: string | null;
  retryAfterMs: number | null;
};

export type RequestOptions = {
  rateKey?: string;
  rateCost?: number;
  logicalMethod?: string;
  logicalCount?: number;
};

export type HttpMetricsSnapshot = {
  startedAt: string;
  totalHttpRequests: number;
  totalLogicalRequests: number;
  requestsByMethod: Record<string, number>;
  statusCounts: Record<string, number>;
  rateLimit429Count: number;
  maxConcurrent: number;
  averageLatencyMs: number | null;
  p95LatencyMs: number | null;
  lastRetryAfterMs: number | null;
  requestsLast5m: number;
  rateLimit429Last5m: number;
};

const BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 32_000, 60_000];
// 官方免费 RPC 的保守上限：全局不超过 5 RPS，给 429/重试留出余量。
const GLOBAL_INTERVAL_MS = Math.ceil(1_000 / 5);
const MAX_HTTP_CONCURRENCY = 6;

type MutableHttpMetrics = {
  startedAt: string;
  totalHttpRequests: number;
  totalLogicalRequests: number;
  requestsByMethod: Record<string, number>;
  statusCounts: Record<string, number>;
  rateLimit429Count: number;
  maxConcurrent: number;
  inFlight: number;
  latenciesMs: number[];
  lastRetryAfterMs: number | null;
  recentRequests: Array<{ at: number; status: number | null }>;
};

const metrics: MutableHttpMetrics = {
  startedAt: new Date().toISOString(),
  totalHttpRequests: 0,
  totalLogicalRequests: 0,
  requestsByMethod: {},
  statusCounts: {},
  rateLimit429Count: 0,
  maxConcurrent: 0,
  inFlight: 0,
  latenciesMs: [],
  lastRetryAfterMs: null,
  recentRequests: [],
};

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1_000));
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}

class RequestGovernor {
  private queue: Promise<void> = Promise.resolve();
  private globalNextAt = 0;
  private methodNextAt = new Map<string, number>();
  private active = 0;
  private waiters: Array<() => void> = [];

  async acquire(rateKey: string, rateCost = 1): Promise<() => void> {
    while (this.active >= MAX_HTTP_CONCURRENCY) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    metrics.inFlight = this.active;
    metrics.maxConcurrent = Math.max(metrics.maxConcurrent, this.active);

    let releaseQueue: () => void = () => undefined;
    const previous = this.queue;
    this.queue = new Promise<void>((resolve) => { releaseQueue = resolve; });
    await previous;
    const now = Date.now();
    const methodInterval = rateKey === "http" || rateKey === "http:get" || rateKey === "http:post"
      ? GLOBAL_INTERVAL_MS
      : rateKey === "rpc:getTransaction" ? Math.ceil(1_000 / 3)
        : rateKey === "rpc:getSignaturesForAddress" ? 1_000
          : 0;
    const previousMethodAt = this.methodNextAt.get(rateKey) ?? 0;
    const waitMs = Math.max(0, this.globalNextAt - now, previousMethodAt - now);
    const startAt = now + waitMs;
    this.globalNextAt = startAt + GLOBAL_INTERVAL_MS * Math.max(1, rateCost);
    if (methodInterval > 0) this.methodNextAt.set(rateKey, startAt + methodInterval * Math.max(1, rateCost));
    if (waitMs > 0) await sleep(waitMs);
    const sharedRelease = await acquireSharedHttpLease(rateKey, rateCost);
    releaseQueue();
    return () => {
      sharedRelease();
      this.active = Math.max(0, this.active - 1);
      metrics.inFlight = this.active;
      this.waiters.shift()?.();
    };
  }
}

const governor = new RequestGovernor();

function recordRequest(meta: HttpMeta, options: RequestOptions = {}) {
  const method = options.logicalMethod ?? options.rateKey ?? "http";
  const count = Math.max(1, options.logicalCount ?? 1);
  metrics.totalHttpRequests += 1;
  metrics.totalLogicalRequests += count;
  metrics.requestsByMethod[method] = (metrics.requestsByMethod[method] ?? 0) + count;
  const status = meta.status === null ? "network_error" : String(meta.status);
  metrics.statusCounts[status] = (metrics.statusCounts[status] ?? 0) + 1;
  if (meta.status === 429) metrics.rateLimit429Count += 1;
  metrics.recentRequests.push({ at: Date.now(), status: meta.status });
  const cutoff = Date.now() - 5 * 60_000;
  while (metrics.recentRequests[0] && metrics.recentRequests[0].at < cutoff) metrics.recentRequests.shift();
  if (meta.retryAfterMs !== null) metrics.lastRetryAfterMs = meta.retryAfterMs;
  if (meta.latencyMs !== null && Number.isFinite(meta.latencyMs)) {
    metrics.latenciesMs.push(meta.latencyMs);
    if (metrics.latenciesMs.length > 50_000) metrics.latenciesMs.splice(0, metrics.latenciesMs.length - 50_000);
  }
}

export function getHttpMetricsSnapshot(): HttpMetricsSnapshot {
  const sorted = [...metrics.latenciesMs].sort((a, b) => a - b);
  const average = sorted.length > 0 ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null;
  const p95 = sorted.length > 0 ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] : null;
  return {
    startedAt: metrics.startedAt,
    totalHttpRequests: metrics.totalHttpRequests,
    totalLogicalRequests: metrics.totalLogicalRequests,
    requestsByMethod: { ...metrics.requestsByMethod },
    statusCounts: { ...metrics.statusCounts },
    rateLimit429Count: metrics.rateLimit429Count,
    maxConcurrent: metrics.maxConcurrent,
    averageLatencyMs: average === null ? null : Math.round(average),
    p95LatencyMs: p95 === null ? null : Math.round(p95),
    lastRetryAfterMs: metrics.lastRetryAfterMs,
    requestsLast5m: metrics.recentRequests.length,
    rateLimit429Last5m: metrics.recentRequests.filter((item) => item.status === 429).length,
  };
}

async function runRequest<T>(url: string, init: RequestInit, timeoutMs: number, options: RequestOptions): Promise<{ data: T | null; meta: HttpMeta }> {
  const startedAt = Date.now();
  const fetchedAt = new Date().toISOString();
  const release = await governor.acquire(options.rateKey ?? "http", options.rateCost ?? 1);
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    const retryAfterMs = response.status === 429 ? parseRetryAfter(response.headers.get("retry-after")) : null;
    const meta: HttpMeta = {
      url,
      status: response.status,
      latencyMs: Date.now() - startedAt,
      fetchedAt,
      error: response.ok ? null : `HTTP ${response.status}`,
      retryAfterMs,
    };
    if (!response.ok) {
      recordRequest(meta, options);
      return { data: null, meta };
    }
    const data = (await response.json()) as T;
    recordRequest(meta, options);
    return { data, meta };
  } catch (error) {
    const meta: HttpMeta = {
      url,
      status: null,
      latencyMs: Date.now() - startedAt,
      fetchedAt,
      error: error instanceof Error ? error.message : "请求失败",
      retryAfterMs: null,
    };
    recordRequest(meta, options);
    return { data: null, meta };
  } finally {
    release();
  }
}

export async function getJson<T>(url: string, timeoutMs = 12_000): Promise<{ data: T | null; meta: HttpMeta }> {
  return runRequest<T>(url, {
    headers: {
      accept: "application/json",
      "user-agent": "LP-Decision-OS/3.0",
    },
  }, timeoutMs, { rateKey: "http:get", logicalMethod: "http:get" });
}

export async function postJson<T>(
  url: string,
  body: unknown,
  timeoutMs = 12_000,
  options: RequestOptions = {},
): Promise<{ data: T | null; meta: HttpMeta }> {
  return runRequest<T>(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "LP-Decision-OS/3.0",
    },
    body: JSON.stringify(body),
  }, timeoutMs, { rateKey: options.rateKey ?? "http:post", ...options });
}

export const exponentialBackoffMs = (retryIndex: number) => BACKOFF_MS[Math.min(BACKOFF_MS.length - 1, Math.max(0, retryIndex))];

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;

  async function runWorker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, () => runWorker()));
  return results;
}
