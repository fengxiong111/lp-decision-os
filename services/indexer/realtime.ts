import { startRaydiumTransactionStream, type ChainEvent } from "@/services/indexer";
import { discoverRwaUsdcPools } from "@/services/raydium/api";
import { fetchPoolKeys } from "@/services/raydium/keys";
import { getActiveRpcProvider, getRpcPoolSnapshot, parseProgramTransaction, rpcRequest, type HistoricalTransaction, type ProgramBackfillPool, type RpcProvider } from "@/services/rpc/pool";
import { getHttpMetricsSnapshot } from "@/services/shared/http";
import { getStorageMetricsSnapshot, persistIndexerState, persistRpcTransactionCache, persistSwapEvents, readIndexerState, readRpcTransactionCache, type CachedRpcTransaction } from "@/services/storage/event-index";
import { evaluateUniverseExpansion, expansionDiagnostics, selectShortWindowPools, selectTier2PoolIds, readUniverseExpansionState } from "@/services/indexer/expansion";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const REFRESH_INTERVAL_MS = 5 * 60_000;

type ActiveState = {
  provider: RpcProvider | null;
  pools: ProgramBackfillPool[];
  refreshedAt: number;
};

let active: ActiveState = { provider: null, pools: [], refreshedAt: 0 };
const inFlight = new Set<string>();
let tier2Cursor = 0;
let lastTier2At = 0;

function persistRealtimeRpcMetrics(): void {
  const metrics = getHttpMetricsSnapshot();
  persistIndexerState("rpc.metrics.indexer", metrics);
}

function toProgramPool(
  pool: Awaited<ReturnType<typeof discoverRwaUsdcPools>>["pools"][number],
  keys: Awaited<ReturnType<typeof fetchPoolKeys>>["keys"],
): ProgramBackfillPool {
  const assetIsA = pool.mintA.address !== USDC_MINT;
  const asset = assetIsA ? pool.mintA : pool.mintB;
  const quote = assetIsA ? pool.mintB : pool.mintA;
  return {
    id: pool.id,
    programId: pool.programId,
    poolKind: pool.kind,
    vaultA: keys.get(pool.id)?.vaultA ?? null,
    vaultB: keys.get(pool.id)?.vaultB ?? null,
    assetMint: asset.address,
    quoteMint: quote.address,
    currentPrice: pool.price === null ? null : assetIsA ? pool.price : pool.price > 0 ? 1 / pool.price : null,
    feeRate: pool.feeRate,
    hasDynamicFee: pool.hasDynamicFee === true,
  };
}

async function refreshActivePools(): Promise<void> {
  const discovery = await discoverRwaUsdcPools();
  const expansion = evaluateUniverseExpansion(discovery.pools, discovery.universe);
  const recoveryPools = selectShortWindowPools(discovery.pools, expansion);
  const tier2PoolIds = selectTier2PoolIds(expansion);
  const rpc = await getRpcPoolSnapshot();
  const provider = getActiveRpcProvider(rpc);
  persistIndexerState("rpc.pool", rpc);
  const keyResult = await fetchPoolKeys(recoveryPools.map((pool) => pool.id));
  active = {
    provider,
    pools: recoveryPools.map((pool) => toProgramPool(pool, keyResult.keys)),
    refreshedAt: Date.now(),
  };
  persistIndexerState("realtime.pools", {
    refreshedAt: new Date(active.refreshedAt).toISOString(),
    poolCount: active.pools.length,
    parserRecoveryPoolIds: active.pools.map((pool) => pool.id),
    parserRecoveryPolicy: expansion.stage === "STAGE_B" ? "阶段B：基线 + 已通过准入流程的Tier1" : "阶段A：仅 SPCX/USDC 0.25% 与 SPCXx/USDC 0.8%",
    tier2PoolIds,
    tier2Policy: expansion.stage === "STAGE_B" ? "官方24h + 低频实时积累；不进入高频 getTransaction" : "阶段A未启动Tier2监听",
    expansion: expansionDiagnostics(expansion),
    publicPoolCount: discovery.pools.length,
    eligiblePoolCount: discovery.universe.activePoolCount,
    officialOnlyPoolCount: discovery.universe.officialOnlyPoolCount,
    quarantinedPoolCount: discovery.universe.quarantinedPoolCount,
    provider: provider?.label ?? null,
    apiStatus: discovery.apiStatus,
    error: discovery.errors[0] ?? keyResult.error,
  });
  persistRealtimeRpcMetrics();
}

async function ingestTier2LowFrequency(): Promise<void> {
  const state = readUniverseExpansionState();
  if (!state || state.stage !== "STAGE_B" || active.provider === null || active.pools.length === 0) return;
  const throttle = readIndexerState<{ status?: string }>("backfill.throttle");
  if (throttle?.status === "PAUSED" || throttle?.status === "THROTTLED") return;
  const metrics = getHttpMetricsSnapshot();
  const last30 = metrics.rpcFailureStats.last30m;
  if (last30.requests > 0 && (last30.rateLimit429 / last30.requests) > 0.05) return;
  const discovery = await discoverRwaUsdcPools();
  const tier2Ids = selectTier2PoolIds(state);
  if (tier2Ids.length === 0) return;
  const poolId = tier2Ids[tier2Cursor % tier2Ids.length];
  tier2Cursor = (tier2Cursor + 1) % tier2Ids.length;
  const pool = discovery.pools.find((item) => item.id === poolId);
  if (!pool) return;
  const keyResult = await fetchPoolKeys([pool.id]);
  const programPool = toProgramPool(pool, keyResult.keys);
  const signatures = await rpcRequest<Array<{ signature?: string; slot?: number; blockTime?: number | null; err?: unknown }>>(active.provider, "getSignaturesForAddress", [pool.id, { limit: 1, commitment: "confirmed" }], 20_000);
  const item = signatures.result?.find((value) => typeof value.signature === "string" && !value.err);
  if (!item?.signature) return;
  const cached = readRpcTransactionCache([item.signature]).get(item.signature);
  let transaction: HistoricalTransaction | null = cached?.status === "SUCCESS" && cached.payload ? cached.payload as HistoricalTransaction : null;
  if (!transaction) {
    const response = await rpcRequest<HistoricalTransaction>(active.provider, "getTransaction", [item.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }], 20_000);
    transaction = response.result;
    persistRpcTransactionCache([{
      signature: item.signature,
      slot: transaction?.slot ?? item.slot ?? null,
      blockTime: transaction?.blockTime ?? item.blockTime ?? null,
      payload: transaction,
      status: transaction ? "SUCCESS" : "FAILED",
      error: response.error,
      fetchedAt: new Date().toISOString(),
      providerUrl: active.provider.url,
    }]);
  }
  if (!transaction) return;
  const parsed = parseProgramTransaction(programPool, item.signature, transaction, new Date().toISOString());
  if (parsed.event) persistSwapEvents([{ ...parsed.event, source: "websocket" }], [pool.id]);
  persistIndexerState("realtime.tier2", {
    stage: "STAGE_B",
    poolId,
    signature: item.signature,
    parsed: parsed.events.length,
    cursor: tier2Cursor,
    poolCount: tier2Ids.length,
    checkedAt: new Date().toISOString(),
  });
}

async function ingestEvent(event: ChainEvent): Promise<void> {
  const signature = event.signature;
  if (!signature || inFlight.has(signature)) return;
  inFlight.add(signature);
  try {
    const provider = active.provider;
    if (!provider || active.pools.length === 0) return;
    const cached = readRpcTransactionCache([signature]).get(signature);
    let transaction: HistoricalTransaction | null = cached?.status === "SUCCESS" && cached.payload
      ? cached.payload as HistoricalTransaction
      : null;
    if (!transaction) {
      const response = await rpcRequest<HistoricalTransaction>(provider, "getTransaction", [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }], 20_000);
      transaction = response.result;
      const cache: CachedRpcTransaction = {
        signature,
        slot: transaction?.slot ?? event.slot,
        blockTime: transaction?.blockTime ?? null,
        payload: transaction,
        status: transaction ? "SUCCESS" : "FAILED",
        error: response.error,
        fetchedAt: new Date().toISOString(),
        providerUrl: provider.url,
      };
      persistRpcTransactionCache([cache]);
      if (!transaction) {
        persistIndexerState("realtime.parse_error", { signature, slot: event.slot, error: response.error ?? "getTransaction 返回空", checkedAt: new Date().toISOString() });
        return;
      }
    }
    const parsedEvents = active.pools.flatMap((pool) => {
      const parsed = parseProgramTransaction(pool, signature, transaction as HistoricalTransaction, event.observedAt);
      return parsed.event ? [{ ...parsed.event, source: "websocket" as const }] : [];
    });
    if (parsedEvents.length === 0) return;
    const stored = persistSwapEvents(parsedEvents, parsedEvents.map((item) => item.poolId));
    persistIndexerState("realtime.last_swap", {
      signature,
      slot: event.slot,
      parsed: parsedEvents.length,
      persisted: stored.persistedEventCount,
      checkedAt: new Date().toISOString(),
      storage: getStorageMetricsSnapshot(),
    });
    persistRealtimeRpcMetrics();
  } finally {
    inFlight.delete(signature);
  }
}

export async function runRealtimeWorker(): Promise<void> {
  const intervalMs = Math.max(30_000, Number(process.env.LP_INDEXER_INTERVAL_MS ?? 60_000));
  const runForMs = Math.max(0, Number(process.env.LP_INDEXER_RUN_FOR_MS ?? 0));
  const startedAt = Date.now();
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  persistIndexerState("worker.lifecycle.indexer", { status: "RUNNING", startedAt: new Date(startedAt).toISOString(), pid: process.pid });
  try {
    await refreshActivePools();
    // refreshActivePools 可能在多个 worker 同时首次初始化 SQLite 时与 schema
    // 建表竞争；再次写入让健康接口不会长期残留上一次进程的 PID。
    persistIndexerState("worker.lifecycle.indexer", { status: "RUNNING", startedAt: new Date(startedAt).toISOString(), pid: process.pid });
    let stream = startRaydiumTransactionStream((event) => { void ingestEvent(event); }, { poolIds: active.pools.map((pool) => pool.id) });
    let subscribedPoolIds = active.pools.map((pool) => pool.id).sort().join(",");
    try {
      while (!stopped && (runForMs === 0 || Date.now() - startedAt < runForMs)) {
        if (Date.now() - active.refreshedAt >= REFRESH_INTERVAL_MS) {
          try {
            await refreshActivePools();
            const nextPoolIds = active.pools.map((pool) => pool.id).sort().join(",");
            if (nextPoolIds !== subscribedPoolIds) {
              stream.stop();
              stream = startRaydiumTransactionStream((event) => { void ingestEvent(event); }, { poolIds: active.pools.map((pool) => pool.id) });
              subscribedPoolIds = nextPoolIds;
            }
          } catch (error) {
            persistIndexerState("realtime.refresh_error", { error: error instanceof Error ? error.message : "实时池刷新失败", checkedAt: new Date().toISOString() });
          }
        }
        const tier2IntervalMs = Math.max(5 * 60_000, Number(process.env.LP_TIER2_REALTIME_INTERVAL_MS ?? 5 * 60_000));
        if (Date.now() - lastTier2At >= tier2IntervalMs) {
          lastTier2At = Date.now();
          try { await ingestTier2LowFrequency(); } catch (error) {
            persistIndexerState("realtime.tier2_error", { error: error instanceof Error ? error.message : "Tier2 低频监听失败", checkedAt: new Date().toISOString() });
          }
        }
        if (!stopped) await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    } finally {
      stream.stop();
    }
  } finally {
    persistRealtimeRpcMetrics();
    persistIndexerState("worker.lifecycle.indexer", { status: "STOPPED", startedAt: new Date(startedAt).toISOString(), stoppedAt: new Date().toISOString(), pid: process.pid });
  }
}
