import { type EventWindowCoverage, type IndexerStatusReport, type PublicMetricsState, type WindowKey } from "@/packages/models/src";
import { buildPersistedPoolMetrics } from "@/services/indexer/buckets";
import { RAW_BACKFILL_JOB_ID, SHORT_WINDOWS, deriveWindowCoverage, formatEta, isCursorComplete } from "@/services/indexer/progress";
import { discoverRwaUsdcPools } from "@/services/raydium/api";
import { refreshPublicMarketSnapshot } from "@/services/raydium/snapshot";
import { publishMarketProjection } from "@/services/projection/market";
import { selectTop20Pools } from "@/services/indexer/universe";
import { getHttpMetricsSnapshot } from "@/services/shared/http";
import { getStorageMetricsSnapshot, persistIndexerState, readBackfillJob, readBackfillPoolCursors, readIndexerState, readMinuteBuckets, readNormalizedSwaps, readWindowCoverage } from "@/services/storage/event-index";

const WINDOW_MS: Record<WindowKey, number> = { "1m": 60_000, "5m": 5 * 60_000, "30m": 30 * 60_000, "1h": 60 * 60_000, "6h": 6 * 60 * 60_000, "12h": 12 * 60 * 60_000, "24h": 24 * 60 * 60_000 };
let lastPublicSnapshotAt = 0;

function emptyCoverage(window: WindowKey, now: Date): EventWindowCoverage {
  return {
    eventCount: 0,
    poolCount: 0,
    firstSlot: null,
    lastSlot: null,
    firstEventAt: null,
    lastEventAt: null,
    completeness: null,
    persisted: false,
    source: "尚未落库",
    windowStart: new Date(now.getTime() - WINDOW_MS[window]).toISOString(),
    windowEnd: now.toISOString(),
    startSlot: null,
    endSlot: null,
    expectedSlotRange: null,
    signaturesDiscovered: 0,
    transactionsFetched: 0,
    transactionsSuccessful: 0,
    transactionsFailed: 0,
    swapsParsed: 0,
    swapsRejected: 0,
    duplicatesRemoved: 0,
    unknownInstructions: null,
    gapSlots: null,
    coverageRatio: null,
    firstEventTime: null,
    lastEventTime: null,
    backfillStatus: "UNAVAILABLE",
  };
}

function streamStatus(): string {
  const status = readIndexerState<{ status?: string }>("stream.status");
  return status?.status ?? "NOT_CONFIGURED";
}

function statusReport(input: { apiReady: boolean; coverage: Record<"1h" | "6h" | "12h", EventWindowCoverage>; feeReady: boolean; routeReady: boolean }): IndexerStatusReport {
  const stream = streamStatus();
  return {
    PUBLIC_MARKET_DATA: input.apiReady ? "READY" : "UNAVAILABLE",
    REALTIME_STREAM: stream,
    HISTORICAL_BACKFILL_1H: input.coverage["1h"].backfillStatus,
    HISTORICAL_BACKFILL_6H: input.coverage["6h"].backfillStatus,
    HISTORICAL_BACKFILL_12H: input.coverage["12h"].backfillStatus,
    HISTORICAL_BACKFILL_24H: "OFFICIAL_API_REFERENCE_ONLY",
    FEE_PARSER: input.feeReady ? "PARTIAL_REAL_FEE" : "UNAVAILABLE",
    ROUTE_SHARE: input.routeReady ? "READY" : "WAITING_COMPLETE_WINDOW",
    OFFICIAL_RECONCILIATION: "WAITING_COMPLETE_WINDOW",
    NET_YIELD_MODEL: "NOT_IMPLEMENTED",
    WALLET_POSITIONS: "OPTIONAL",
  };
}

function deriveSourceCoverage(
  poolIds: string[],
  stored: Record<string, Record<WindowKey, EventWindowCoverage>>,
  cursors: ReturnType<typeof readBackfillPoolCursors>,
  job: ReturnType<typeof readBackfillJob>,
  now: Date,
): Record<string, Record<WindowKey, EventWindowCoverage>> {
  const cursorMap = new Map(cursors.map((cursor) => [cursor.poolAddress, cursor]));
  return Object.fromEntries(poolIds.map((poolId) => {
    const base = stored[poolId] ?? Object.fromEntries(Object.keys(WINDOW_MS).map((window) => [window, emptyCoverage(window as WindowKey, now)])) as Record<WindowKey, EventWindowCoverage>;
    const cursor = cursorMap.get(poolId);
    const windows = { ...base } as Record<WindowKey, EventWindowCoverage>;
    if (cursor && job) {
      for (const window of SHORT_WINDOWS) {
        windows[window] = deriveWindowCoverage({ window, cursors: [cursor], targetPoolCount: 1, now, job, base: base[window] });
      }
    } else {
      // 旧 worker 的 window_coverage 不能冒充新 raw 12h 任务进度；保留分钟事实
      // 供诊断，但在统一任务启动前不让它进入短窗口排名。
      for (const window of SHORT_WINDOWS) windows[window] = emptyCoverage(window, now);
    }
    return [poolId, windows];
  }));
}

function deriveGlobalCoverage(
  built: Record<WindowKey, EventWindowCoverage>,
  poolIds: string[],
  cursors: ReturnType<typeof readBackfillPoolCursors>,
  job: ReturnType<typeof readBackfillJob>,
  now: Date,
): Record<WindowKey, EventWindowCoverage> {
  const windows = { ...built } as Record<WindowKey, EventWindowCoverage>;
  if (!job) return windows;
  for (const window of SHORT_WINDOWS) {
    windows[window] = deriveWindowCoverage({ window, cursors, targetPoolCount: poolIds.length, now, job, base: built[window] });
  }
  return windows;
}

export async function runMetricsCycle(now = new Date()): Promise<PublicMetricsState> {
  const discovery = await discoverRwaUsdcPools();
  const poolIds = discovery.pools.map((pool) => pool.id);
  const top20Pools = selectTop20Pools(discovery.pools);
  const top20PoolIds = top20Pools.map((pool) => pool.id);
  const stored = readWindowCoverage(poolIds);
  const job = readBackfillJob(RAW_BACKFILL_JOB_ID);
  const cursors = readBackfillPoolCursors(RAW_BACKFILL_JOB_ID, poolIds);
  const top20Cursors = cursors.filter((cursor) => top20PoolIds.includes(cursor.poolAddress));
  const buckets = readMinuteBuckets(poolIds, new Date(now.getTime() - 12 * 60 * 60_000));
  const events = readNormalizedSwaps(poolIds, new Date(now.getTime() - 12 * 60 * 60_000));
  const eventsByPool = new Map<string, typeof events>();
  for (const event of events) eventsByPool.set(event.poolId, [...(eventsByPool.get(event.poolId) ?? []), event]);
  const sourceCoverage = deriveSourceCoverage(poolIds, stored, cursors, job, now);
  const built = buildPersistedPoolMetrics({
    pools: discovery.pools.map((pool) => ({ id: pool.id, pairKey: pool.mintA.address === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" ? pool.mintB.address : pool.mintA.address, tvl: pool.tvl, effectiveActiveTvl: pool.tvl })),
    buckets,
    eventsByPool,
    sourceCoverage,
    asOf: now.toISOString(),
  });
  const builtTop20 = buildPersistedPoolMetrics({
    pools: top20Pools.map((pool) => ({ id: pool.id, pairKey: pool.mintA.address === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" ? pool.mintB.address : pool.mintA.address, tvl: pool.tvl, effectiveActiveTvl: pool.tvl })),
    buckets,
    eventsByPool,
    sourceCoverage,
    asOf: now.toISOString(),
  });
  const windows = deriveGlobalCoverage(builtTop20.windows, top20PoolIds, top20Cursors, job, now);
  const completedTop20 = job
    ? top20Cursors.filter((cursor) => isCursorComplete(cursor, new Date(job.targetBlockTime))).length
    : 0;
  const feeReady = events.some((event) => event.feeUsd !== null && event.lpFeeAtomic !== null);
  const routeReady = SHORT_WINDOWS.some((window) => windows[window].backfillStatus === "COMPLETE" || windows[window].backfillStatus === "LIVE");
  const status = statusReport({ apiReady: discovery.pools.length > 0, coverage: { "1h": windows["1h"], "6h": windows["6h"], "12h": windows["12h"] }, feeReady, routeReady });
  const state: PublicMetricsState = {
    generatedAt: now.toISOString(),
    source: "indexer-worker",
    pools: built.pools,
    windows,
    status,
    detail: job
      ? `Top20 短窗口：${completedTop20}/${top20PoolIds.length} Pool · ${job.status} · ${formatEta(job.etaMs)} · SQLite ${getStorageMetricsSnapshot().rowsWritten} 行`
      : `Top20 短窗口：0/${top20PoolIds.length} Pool · 等待回补 worker · SQLite ${getStorageMetricsSnapshot().rowsWritten} 行`,
  };
  persistIndexerState("metrics.public", state);
  persistIndexerState("metrics.diagnostics", {
    checkedAt: now.toISOString(),
    job,
    rpc: getHttpMetricsSnapshot(),
    storage: getStorageMetricsSnapshot(),
    bucketCount: buckets.length,
    normalizedSwapCount: events.length,
    poolCount: poolIds.length,
  });
  // metrics worker 主要访问 Raydium API；单独保存，健康接口不会把它与 Solana RPC
  // worker 混成一个不可解释的数字。
  persistIndexerState("rpc.metrics.metrics", getHttpMetricsSnapshot());
  return state;
}

export async function runMetricsWorker(): Promise<void> {
  const intervalMs = Math.max(30_000, Number(process.env.LP_METRICS_INTERVAL_MS ?? 60_000));
  const runForMs = Math.max(0, Number(process.env.LP_METRICS_RUN_FOR_MS ?? 0));
  const startedAt = Date.now();
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  persistIndexerState("worker.lifecycle.metrics", { status: "RUNNING", startedAt: new Date(startedAt).toISOString(), pid: process.pid });
  try {
    while (!stopped && (runForMs === 0 || Date.now() - startedAt < runForMs)) {
      try { await runMetricsCycle(); } catch (error) {
        persistIndexerState("metrics.error", { error: error instanceof Error ? error.message : "指标 worker 失败", checkedAt: new Date().toISOString() });
      }
      if (Date.now() - lastPublicSnapshotAt >= Math.max(60_000, Number(process.env.LP_PUBLIC_SNAPSHOT_INTERVAL_MS ?? 300_000))) {
        try {
          const snapshot = await refreshPublicMarketSnapshot();
          publishMarketProjection(snapshot);
          lastPublicSnapshotAt = Date.now();
        } catch (error) {
          persistIndexerState("public_snapshot.error", { error: error instanceof Error ? error.message : "公开市场快照刷新失败", checkedAt: new Date().toISOString() });
        }
      }
      if (!stopped) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } finally {
    persistIndexerState("worker.lifecycle.metrics", { status: "STOPPED", startedAt: new Date(startedAt).toISOString(), stoppedAt: new Date().toISOString(), pid: process.pid });
  }
}
