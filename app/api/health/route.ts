import { getDashboardSnapshot } from "@/services/raydium/snapshot";
import { RAW_BACKFILL_JOB_ID } from "@/services/indexer/progress";
import { getStorageMetricsSnapshot, readBackfillFailures, readBackfillJob, readBackfillPoolCursors, readIndexerState } from "@/services/storage/event-index";
import { jsonWithNullSemantics } from "@/services/shared/null-semantics";
import type { RpcFailureStats, RpcFailureStatsWindow } from "@/services/shared/http";

export const dynamic = "force-dynamic";

type RpcMetrics = {
  startedAt?: string;
  totalHttpRequests?: number;
  totalLogicalRequests?: number;
  requestsByMethod?: Record<string, number>;
  statusCounts?: Record<string, number>;
  rateLimit429Count?: number;
  maxConcurrent?: number;
  averageLatencyMs?: number | null;
  p95LatencyMs?: number | null;
  lastRetryAfterMs?: number | null;
  requestsLast5m?: number;
  rateLimit429Last5m?: number;
  requestsLast15m?: number;
  rateLimit429Last15m?: number;
  requestsLast30m?: number;
  rateLimit429Last30m?: number;
  requestsLast1h?: number;
  rateLimit429Last1h?: number;
  rpcFailureStats?: RpcFailureStats;
};

function aggregateRpcMetrics(metricsByWorker: Record<string, RpcMetrics | null>): RpcMetrics | null {
  const rows = Object.values(metricsByWorker).filter((item): item is RpcMetrics => Boolean(item));
  if (rows.length === 0) return null;
  const sum = (key: keyof RpcMetrics) => rows.reduce((total, row) => total + (typeof row[key] === "number" ? row[key] as number : 0), 0);
  const requestsByMethod: Record<string, number> = {};
  const statusCounts: Record<string, number> = {};
  for (const row of rows) {
    for (const [method, count] of Object.entries(row.requestsByMethod ?? {})) requestsByMethod[method] = (requestsByMethod[method] ?? 0) + count;
    for (const [status, count] of Object.entries(row.statusCounts ?? {})) statusCounts[status] = (statusCounts[status] ?? 0) + count;
  }
  const total = sum("totalHttpRequests");
  const weightedAverage = total > 0
    ? rows.reduce((value, row) => value + (row.averageLatencyMs ?? 0) * (row.totalHttpRequests ?? 0), 0) / total
    : null;
  const mergeFailureWindow = (key: keyof RpcFailureStats): RpcFailureStatsWindow => {
    const merged: RpcFailureStatsWindow = { requests: 0, failures: 0, networkErrors: 0, rateLimit429: 0, byCategory: {} };
    for (const row of rows) {
      const item = row.rpcFailureStats?.[key];
      if (!item) continue;
      merged.requests += item.requests;
      merged.failures += item.failures;
      merged.networkErrors += item.networkErrors;
      merged.rateLimit429 += item.rateLimit429;
      for (const [category, count] of Object.entries(item.byCategory)) merged.byCategory[category] = (merged.byCategory[category] ?? 0) + count;
    }
    return merged;
  };
  const rpcFailureStats: RpcFailureStats = {
    lifetime: mergeFailureWindow("lifetime"),
    last15m: mergeFailureWindow("last15m"),
    last30m: mergeFailureWindow("last30m"),
    last1h: mergeFailureWindow("last1h"),
    currentRun: mergeFailureWindow("currentRun"),
  };
  return {
    startedAt: rows.map((row) => row.startedAt).filter((value): value is string => Boolean(value)).sort()[0],
    totalHttpRequests: total,
    totalLogicalRequests: sum("totalLogicalRequests"),
    requestsByMethod,
    statusCounts,
    rateLimit429Count: sum("rateLimit429Count"),
    maxConcurrent: Math.max(...rows.map((row) => row.maxConcurrent ?? 0)),
    averageLatencyMs: weightedAverage === null ? null : Math.round(weightedAverage),
    // 每个 worker 只保存聚合延迟分位数，跨进程无法精确合并原始样本；取最大值并明确
    // 这是保守上界，避免伪造精确全局 p95。
    p95LatencyMs: Math.max(...rows.map((row) => row.p95LatencyMs ?? 0)) || null,
    lastRetryAfterMs: Math.max(...rows.map((row) => row.lastRetryAfterMs ?? 0)) || null,
    requestsLast5m: sum("requestsLast5m"),
    rateLimit429Last5m: sum("rateLimit429Last5m"),
    requestsLast15m: sum("requestsLast15m"),
    rateLimit429Last15m: sum("rateLimit429Last15m"),
    requestsLast30m: sum("requestsLast30m"),
    rateLimit429Last30m: sum("rateLimit429Last30m"),
    requestsLast1h: sum("requestsLast1h"),
    rateLimit429Last1h: sum("rateLimit429Last1h"),
    rpcFailureStats,
  };
}

export async function GET() {
  // 健康接口也只读最近成功快照，不在页面请求路径触发 RPC。
  const snapshot = await getDashboardSnapshot();
  const backfillJob = readBackfillJob(RAW_BACKFILL_JOB_ID);
  const backfillCursors = readBackfillPoolCursors(RAW_BACKFILL_JOB_ID);
  const rpcByWorker = {
    backfill: readIndexerState<RpcMetrics>("rpc.metrics.backfill"),
    indexer: readIndexerState<RpcMetrics>("rpc.metrics.indexer"),
    metrics: readIndexerState<RpcMetrics>("rpc.metrics.metrics"),
  };
  return jsonWithNullSemantics({
    ...snapshot,
    diagnostics: {
      rpc: aggregateRpcMetrics(rpcByWorker) ?? readIndexerState("rpc.metrics"),
      rpcByWorker,
      backfill: {
        job: backfillJob,
        cursors: backfillCursors,
        failures: readBackfillFailures(RAW_BACKFILL_JOB_ID, 100),
      },
      stream: readIndexerState("stream.status"),
      metrics: readIndexerState("metrics.public"),
      backfillThrottle: readIndexerState("backfill.throttle"),
      workerLifecycle: {
        indexer: readIndexerState("worker.lifecycle.indexer"),
        backfill: readIndexerState("worker.lifecycle.backfill"),
        metrics: readIndexerState("worker.lifecycle.metrics"),
      },
      storage: getStorageMetricsSnapshot(),
    },
  }, {
    headers: {
      "cache-control": "no-store",
      "x-data-status": snapshot.status,
    },
  });
}
