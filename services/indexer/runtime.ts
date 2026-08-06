import { type EventWindowCoverage, type IndexerStatusReport, type PublicMetricsState, type WindowKey } from "@/packages/models/src";
import { buildMinuteBuckets, buildPersistedPoolMetrics } from "@/services/indexer/buckets";
import { startRaydiumTransactionStream } from "@/services/indexer";
import { discoverRwaUsdcPools } from "@/services/raydium/api";
import { fetchPoolKeys } from "@/services/raydium/keys";
import { getHttpMetricsSnapshot } from "@/services/shared/http";
import { getActiveRpcProvider, getRpcPoolSnapshot, collectProgramWideRwaSwapEvents, parseProgramTransaction, rpcRequest, type HistoricalTransaction, type ProgramBackfillPool, type ProgramBackfillResult, type RpcProvider } from "@/services/rpc/pool";
import { getStorageMetricsSnapshot, persistIndexerState, persistMinuteBuckets, persistOfficialReconciliation, persistSwapEvents, persistWindowCoverage, readIndexerState, readMinuteBuckets, readRecentSwapEvents, readWindowCoverage, type OfficialReconciliationRow } from "@/services/storage/event-index";
import { getConfiguredReadOnlyAddress } from "@/services/wallet/config";

type RuntimeLog = (message: string) => void;

const log: RuntimeLog = (message) => {
  if (process.env.LP_INDEXER_QUIET !== "1") console.log(`[indexer] ${message}`);
};

let cycleRunning = false;
let lastBackfillAt = 0;
let cachedBackfill: ProgramBackfillResult | null = null;
let cachedBackfillKey = "";
let cachedPoolIds: string[] = [];
let activeProvider: RpcProvider | null = null;
let activePools: ProgramBackfillPool[] = [];

async function ingestStreamEvent(input: { signature: string | null; observedAt: string }): Promise<void> {
  if (!activeProvider || !input.signature || activePools.length === 0) return;
  const startedAt = Date.now();
  const response = await rpcRequest<HistoricalTransaction>(activeProvider, "getTransaction", [input.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }], 12_000);
  if (!response.result) {
    persistIndexerState("stream.parse_error", { signature: input.signature, error: response.error ?? "getTransaction 返回空", checkedAt: new Date().toISOString() });
    return;
  }
  const parsedEvents = activePools.flatMap((pool) => {
    const parsed = parseProgramTransaction(pool, input.signature as string, response.result as HistoricalTransaction, input.observedAt);
    return parsed.event ? [{ ...parsed.event, source: "websocket" as const, parseLatencyMs: Date.now() - startedAt }] : [];
  });
  if (parsedEvents.length === 0) return;
  persistSwapEvents(parsedEvents, parsedEvents.map((event) => event.poolId));
  const quoteMints = new Map(activePools.map((pool) => [pool.id, pool.quoteMint]));
  persistMinuteBuckets(buildMinuteBuckets(parsedEvents, new Date().toISOString(), "PARTIAL", quoteMints));
  persistIndexerState("stream.parse", { signature: input.signature, parsed: parsedEvents.length, checkedAt: new Date().toISOString() });
}

const BACKFILL_WINDOWS: WindowKey[] = ["1h", "6h", "12h", "24h"];
const BACKFILL_HOURS: Record<WindowKey, number> = { "1h": 1, "6h": 6, "12h": 12, "24h": 24, "1m": 1 / 60, "5m": 5 / 60, "30m": 0.5 };
const PRIORITY_SYMBOLS = new Set(["SPCX", "SPCXx", "NVDAX", "DRAM", "SPYx"]);

type BackfillProgress = {
  windowIndex: number;
  tier: 1 | 2 | 3;
  status: "RUNNING" | "COMPLETE";
  startedAt: string;
  windowStartedAt: string;
  windowDurationsMs: Partial<Record<WindowKey, number>>;
  finishedAt: string | null;
  targetPoolCount: number;
};

function assetSymbol(pool: Awaited<ReturnType<typeof discoverRwaUsdcPools>>["pools"][number]): string {
  return pool.mintA.address === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" ? pool.mintB.symbol : pool.mintA.symbol;
}

function priorityPlan(pools: Awaited<ReturnType<typeof discoverRwaUsdcPools>>["pools"]): string[][] {
  const tierOne = pools.filter((pool) => PRIORITY_SYMBOLS.has(assetSymbol(pool))).map((pool) => pool.id);
  const topTwenty = [...pools].sort((a, b) => (b.day.volume ?? 0) - (a.day.volume ?? 0)).slice(0, 20).map((pool) => pool.id);
  const tierTwo = [...new Set([...tierOne, ...topTwenty])];
  return [tierOne, tierTwo, pools.map((pool) => pool.id)];
}

function progressDefault(targetPoolCount: number): BackfillProgress {
  const now = new Date().toISOString();
  return { windowIndex: 0, tier: 1, status: "RUNNING", startedAt: now, windowStartedAt: now, windowDurationsMs: {}, finishedAt: null, targetPoolCount };
}

function targetIsComplete(poolIds: string[], window: WindowKey, coverage: Record<string, Record<WindowKey, EventWindowCoverage>>): boolean {
  return poolIds.length > 0 && poolIds.every((poolId) => coverage[poolId]?.[window]?.backfillStatus === "COMPLETE" && coverage[poolId]?.[window]?.coverageRatio === 100 && coverage[poolId]?.[window]?.gapSlots === 0 && coverage[poolId]?.[window]?.unknownInstructions === 0);
}

function advanceProgress(progress: BackfillProgress, plan: string[][], coverage: Record<string, Record<WindowKey, EventWindowCoverage>>): BackfillProgress {
  let next = {
    ...progress,
    windowStartedAt: progress.windowStartedAt ?? progress.startedAt,
    windowDurationsMs: progress.windowDurationsMs ?? {},
  };
  while (next.windowIndex < BACKFILL_WINDOWS.length) {
    const target = plan[next.tier - 1] ?? [];
    const targetWindowKey = BACKFILL_WINDOWS[next.windowIndex];
    if (!targetIsComplete(target, targetWindowKey, coverage)) break;
    if (next.tier < 3) {
      next = { ...next, tier: (next.tier + 1) as 1 | 2 | 3, targetPoolCount: plan[next.tier]?.length ?? 0 };
      continue;
    }
    if (next.windowIndex < BACKFILL_WINDOWS.length - 1) {
      const completedWindow = BACKFILL_WINDOWS[next.windowIndex];
      const duration = Math.max(0, Date.now() - Date.parse(next.windowStartedAt));
      next = {
        ...next,
        windowIndex: next.windowIndex + 1,
        tier: 1,
        targetPoolCount: plan[0]?.length ?? 0,
        windowStartedAt: new Date().toISOString(),
        windowDurationsMs: { ...next.windowDurationsMs, [completedWindow]: duration },
      };
      continue;
    }
    const completedWindow = BACKFILL_WINDOWS[next.windowIndex];
    const duration = Math.max(0, Date.now() - Date.parse(next.windowStartedAt));
    next = {
      ...next,
      status: "COMPLETE",
      finishedAt: new Date().toISOString(),
      windowDurationsMs: { ...next.windowDurationsMs, [completedWindow]: duration },
    };
    break;
  }
  return next;
}

function statusFromCoverage(coverage: Record<WindowKey, EventWindowCoverage>, window: WindowKey): string {
  return coverage[window]?.backfillStatus ?? "UNAVAILABLE";
}

function buildIndexerStatus(input: {
  apiReady: boolean;
  stream: string;
  coverage: Record<WindowKey, EventWindowCoverage>;
  feeParser: string;
  routeShare: string;
  reconciliation: string;
}): IndexerStatusReport {
  return {
    PUBLIC_MARKET_DATA: input.apiReady ? "READY" : "UNAVAILABLE",
    REALTIME_STREAM: input.stream,
    HISTORICAL_BACKFILL_1H: statusFromCoverage(input.coverage, "1h"),
    HISTORICAL_BACKFILL_6H: statusFromCoverage(input.coverage, "6h"),
    HISTORICAL_BACKFILL_12H: statusFromCoverage(input.coverage, "12h"),
    HISTORICAL_BACKFILL_24H: statusFromCoverage(input.coverage, "24h"),
    FEE_PARSER: input.feeParser,
    ROUTE_SHARE: input.routeShare,
    OFFICIAL_RECONCILIATION: input.reconciliation,
    NET_YIELD_MODEL: "NOT_IMPLEMENTED",
    WALLET_POSITIONS: getConfiguredReadOnlyAddress() ? "OPTIONAL_CONFIGURED" : "OPTIONAL_NOT_CONFIGURED",
  };
}

async function reconcileOfficial(discovery: Awaited<ReturnType<typeof discoverRwaUsdcPools>>, metrics: PublicMetricsState, asOf: string): Promise<string> {
  const rows: OfficialReconciliationRow[] = discovery.pools.map((pool) => {
    const local = metrics.pools[pool.id]?.windows["24h"];
    const localComplete = local?.status === "COMPLETE" && local.coverageRatio === 100;
    const officialVolume = pool.day.volume;
    const officialFee = pool.day.volumeFee;
    const localVolume = localComplete ? local?.volume ?? null : null;
    const localFee = localComplete ? local?.lpFeeUsd ?? null : null;
    const volumeDifferencePct = officialVolume !== null && localVolume !== null && officialVolume !== 0 ? Math.abs((localVolume - officialVolume) / officialVolume) * 100 : null;
    const feeDifferencePct = officialFee !== null && localFee !== null && officialFee !== 0 ? Math.abs((localFee - officialFee) / officialFee) * 100 : null;
    const failed = localComplete && ((volumeDifferencePct !== null && volumeDifferencePct > 1) || (feeDifferencePct !== null && feeDifferencePct > 1));
    return {
      poolId: pool.id,
      officialAsOf: discovery.sources.find((source) => source.label === "Raydium RWA 池发现")?.observedAt ?? asOf,
      localAsOf: local?.asOf ?? null,
      officialTvl: pool.tvl,
      localTvl: local?.activeTvl ?? null,
      officialVolume24h: officialVolume,
      localVolume24h: localVolume,
      officialFee24h: officialFee,
      localFee24h: localFee,
      volumeDifferencePct,
      feeDifferencePct,
      status: failed ? "FAILED" : localComplete && localVolume !== null && (officialFee === null || localFee !== null) ? "READY" : "PARTIAL",
      checkedAt: asOf,
    } satisfies OfficialReconciliationRow;
  });
  persistOfficialReconciliation(rows);
  const failedCount = rows.filter((row) => row.status === "FAILED").length;
  const completeCount = rows.filter((row) => row.status === "READY").length;
  const status = failedCount > 0 ? "FAILED" : completeCount === rows.length && rows.length > 0 ? "READY" : "PARTIAL";
  persistIndexerState("reconciliation.status", { status, checkedAt: asOf, poolCount: rows.length, failedCount, completeCount });
  return status;
}

async function discoverAndBackfill(now: Date): Promise<{ discovery: Awaited<ReturnType<typeof discoverRwaUsdcPools>>; rpc: Awaited<ReturnType<typeof getRpcPoolSnapshot>>; backfill: ProgramBackfillResult | null; coverage: Record<string, Record<WindowKey, EventWindowCoverage>>; events: import("@/packages/models/src").SwapEventRecord[]; progress: BackfillProgress }> {
  const discovery = await discoverRwaUsdcPools();
  const rpc = await getRpcPoolSnapshot();
  const provider = getActiveRpcProvider(rpc);
  const keys = await fetchPoolKeys(discovery.pools.map((pool) => pool.id));
  const knownPools = discovery.pools.map((pool) => {
    const assetIsA = pool.mintA.address !== "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const asset = assetIsA ? pool.mintA : pool.mintB;
    const quote = assetIsA ? pool.mintB : pool.mintA;
    return {
      id: pool.id,
      programId: pool.programId,
      vaultA: keys.keys.get(pool.id)?.vaultA ?? null,
      vaultB: keys.keys.get(pool.id)?.vaultB ?? null,
      assetMint: asset.address,
      quoteMint: quote.address,
      currentPrice: pool.price === null ? null : assetIsA ? pool.price : pool.price > 0 ? 1 / pool.price : null,
    };
  });
  activeProvider = provider;
  activePools = knownPools;
  const poolIds = knownPools.map((pool) => pool.id);
  const plan = priorityPlan(discovery.pools);
  let progress = readIndexerState<BackfillProgress>("backfill.progress") ?? progressDefault(plan[0]?.length ?? 0);
  const existingCoverage = readWindowCoverage(poolIds);
  progress = advanceProgress(progress, plan, existingCoverage);
  if (progress.status === "COMPLETE") persistIndexerState("backfill.progress", progress);
  const targetWindow = BACKFILL_WINDOWS[progress.windowIndex] ?? "24h";
  const targetPoolIds = plan[progress.tier - 1] ?? poolIds;
  const targetKey = `${targetWindow}:tier${progress.tier}:${targetPoolIds.join(",")}`;
  const needsBackfill = progress.status !== "COMPLETE" && targetPoolIds.length > 0 && (cachedBackfill === null || cachedBackfillKey !== targetKey || cachedPoolIds.join(",") !== poolIds.join(",") || Date.now() - lastBackfillAt >= Math.max(60_000, Number(process.env.LP_INDEXER_BACKFILL_INTERVAL_MS ?? 60_000)));
  let backfill = cachedBackfill;
  if (provider && needsBackfill) {
    log(`开始 ${targetWindow} program-wide 回补：tier ${progress.tier} · ${targetPoolIds.length} 个目标 Pool · 官方 RPC`);
    backfill = await collectProgramWideRwaSwapEvents(provider, knownPools, { now, hours: BACKFILL_HOURS[targetWindow], targetWindow, targetPoolIds, poolTier: progress.tier });
    cachedBackfill = backfill;
    cachedBackfillKey = targetKey;
    cachedPoolIds = poolIds;
    lastBackfillAt = Date.now();
    if (backfill.errors.length > 0) log(backfill.errors[0]);
  }
  const coverage = existingCoverage;
  if (backfill) {
    for (const [poolId, windows] of Object.entries(backfill.coverage)) coverage[poolId] = { ...(coverage[poolId] ?? {} as Record<WindowKey, EventWindowCoverage>), ...windows } as Record<WindowKey, EventWindowCoverage>;
    persistWindowCoverage(coverage);
  }
  const backfillEvents = backfill?.events ?? [];
  const storedEvents = readRecentSwapEvents(poolIds, new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const events = [...new Map([...storedEvents, ...backfillEvents].map((event) => [`${event.signature}:${event.instructionIndex ?? 0}:${event.poolId}`, event])).values()];
  if (backfill) {
    persistSwapEvents(backfill.events, poolIds);
  }
  progress = advanceProgress(progress, plan, coverage);
  progress = { ...progress, targetPoolCount: plan[progress.tier - 1]?.length ?? 0 };
  persistIndexerState("backfill.progress", progress);
  const quoteMints = new Map(knownPools.map((pool) => [pool.id, pool.quoteMint]));
  const statusByPool = new Map(knownPools.map((pool) => [pool.id, coverage[pool.id]?.["24h"]?.backfillStatus ?? "PARTIAL" as const]));
  const buckets = knownPools.flatMap((pool) => buildMinuteBuckets(events.filter((event) => event.poolId === pool.id), now.toISOString(), statusByPool.get(pool.id) === "COMPLETE" ? "COMPLETE" : "PARTIAL", quoteMints));
  persistMinuteBuckets(buckets);
  return { discovery, rpc, backfill, coverage, events, progress };
}

export async function runPublicIndexerCycle(): Promise<{ ok: boolean; detail: string }> {
  if (cycleRunning) return { ok: false, detail: "上一轮 indexer cycle 尚未结束" };
  cycleRunning = true;
  const asOf = new Date();
  try {
    const { discovery, rpc, backfill, coverage, events, progress } = await discoverAndBackfill(asOf);
    persistIndexerState("rpc.pool", rpc);
    const poolIds = discovery.pools.map((pool) => pool.id);
    const allBuckets = readMinuteBuckets(poolIds, new Date(asOf.getTime() - 24 * 60 * 60 * 1000));
    const eventsByPool = new Map<string, import("@/packages/models/src").SwapEventRecord[]>();
    for (const event of events) eventsByPool.set(event.poolId, [...(eventsByPool.get(event.poolId) ?? []), event]);
    const metrics = buildPersistedPoolMetrics({
      pools: discovery.pools.map((pool) => ({ id: pool.id, pairKey: pool.mintA.address === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" ? pool.mintB.address : pool.mintA.address, tvl: pool.tvl, effectiveActiveTvl: pool.tvl })),
      buckets: allBuckets,
      eventsByPool,
      sourceCoverage: coverage,
      asOf: asOf.toISOString(),
    });
    const apiReady = discovery.pools.length > 0;
    const feeParser = events.some((event) => event.lpFeeAtomic !== null && event.feeUsd !== null) ? "PARTIAL" : "UNAVAILABLE_UNSUPPORTED_FEE_VERSION";
    const routeShare = Object.values(metrics.pools).some((pool) => pool.routeShareByWindow["1h"].share !== null) ? "PARTIAL" : "UNAVAILABLE";
    const priorReconciliation = readIndexerState<{ status?: string }>("reconciliation.status");
    const status = buildIndexerStatus({ apiReady, stream: readIndexerState<{ status?: string }>("stream.status")?.status ?? "NOT_STARTED", coverage: metrics.windows, feeParser, routeShare, reconciliation: priorReconciliation?.status ?? "NOT_RUN" });
    const rpcMetrics = getHttpMetricsSnapshot();
    persistIndexerState("rpc.metrics", rpcMetrics);
    persistIndexerState("storage.metrics", getStorageMetricsSnapshot());
    const publicState: PublicMetricsState = { generatedAt: asOf.toISOString(), source: "indexer-worker", pools: metrics.pools, windows: metrics.windows, status, detail: backfill ? `${progress.windowIndex < BACKFILL_WINDOWS.length ? BACKFILL_WINDOWS[progress.windowIndex] : "完成"} · tier ${progress.tier} · 扫描 ${backfill.signaturesDiscovered} 个签名 · ${backfill.transactionsFetched} 笔交易 · ${events.length} 笔 Swap 事件` : "等待 RPC 交易回补" };
    persistIndexerState("metrics.public", publicState);
    persistIndexerState("indexer.status", status);
    const reconciliationState = readIndexerState<{ checkedAt?: string }>("reconciliation.status");
    if (!reconciliationState?.checkedAt || Date.now() - Date.parse(reconciliationState.checkedAt) > 5 * 60_000) {
      const reconciliation = await reconcileOfficial(discovery, publicState, asOf.toISOString());
      const nextStatus = { ...status, OFFICIAL_RECONCILIATION: reconciliation } satisfies IndexerStatusReport;
      persistIndexerState("indexer.status", nextStatus);
      persistIndexerState("metrics.public", { ...publicState, status: nextStatus });
    }
    const detail = `${discovery.pools.length} pools · ${events.length} swaps · ${rpc.activeProvider ?? "无 RPC"}`;
    log(`cycle 完成：${detail}`);
    return { ok: true, detail };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "indexer cycle 失败";
    persistIndexerState("indexer.error", { detail, checkedAt: asOf.toISOString() });
    log(detail);
    return { ok: false, detail };
  } finally {
    cycleRunning = false;
  }
}

export async function runIndexerWorker(): Promise<void> {
  const intervalMs = Math.max(15_000, Number(process.env.LP_INDEXER_INTERVAL_MS ?? 60_000));
  const runForMs = Math.max(0, Number(process.env.LP_INDEXER_RUN_FOR_MS ?? 0));
  const startedAt = Date.now();
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const stream = startRaydiumTransactionStream((event) => {
    // 日志流首先落下最后观察位置；下一轮 cycle 通过 RPC getTransaction 做确定性解析。
    persistIndexerState("stream.last_event_received", { receivedAt: new Date().toISOString() });
    void ingestStreamEvent({ signature: event.signature, observedAt: event.observedAt });
  });
  try {
    while (!stopped && (runForMs === 0 || Date.now() - startedAt < runForMs)) {
      await runPublicIndexerCycle();
      if (!stopped) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    persistIndexerState("worker.lifecycle", { status: "STOPPED", startedAt: new Date(startedAt).toISOString(), stoppedAt: new Date().toISOString(), runForMs });
  } finally {
    stream.stop();
  }
}
