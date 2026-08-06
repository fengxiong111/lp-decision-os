import { startRaydiumTransactionStream, type ChainEvent } from "@/services/indexer";
import { discoverRwaUsdcPools } from "@/services/raydium/api";
import { fetchPoolKeys } from "@/services/raydium/keys";
import { getActiveRpcProvider, getRpcPoolSnapshot, parseProgramTransaction, rpcRequest, type HistoricalTransaction, type ProgramBackfillPool, type RpcProvider } from "@/services/rpc/pool";
import { getHttpMetricsSnapshot } from "@/services/shared/http";
import { getStorageMetricsSnapshot, persistIndexerState, persistRpcTransactionCache, persistSwapEvents, readRpcTransactionCache, type CachedRpcTransaction } from "@/services/storage/event-index";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const REFRESH_INTERVAL_MS = 5 * 60_000;

type ActiveState = {
  provider: RpcProvider | null;
  pools: ProgramBackfillPool[];
  refreshedAt: number;
};

let active: ActiveState = { provider: null, pools: [], refreshedAt: 0 };
const inFlight = new Set<string>();

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
    vaultA: keys.get(pool.id)?.vaultA ?? null,
    vaultB: keys.get(pool.id)?.vaultB ?? null,
    assetMint: asset.address,
    quoteMint: quote.address,
    currentPrice: pool.price === null ? null : assetIsA ? pool.price : pool.price > 0 ? 1 / pool.price : null,
  };
}

async function refreshActivePools(): Promise<void> {
  const discovery = await discoverRwaUsdcPools();
  const rpc = await getRpcPoolSnapshot();
  const provider = getActiveRpcProvider(rpc);
  const keyResult = await fetchPoolKeys(discovery.pools.map((pool) => pool.id));
  active = {
    provider,
    pools: discovery.pools.map((pool) => toProgramPool(pool, keyResult.keys)),
    refreshedAt: Date.now(),
  };
  persistIndexerState("realtime.pools", {
    refreshedAt: new Date(active.refreshedAt).toISOString(),
    poolCount: active.pools.length,
    provider: provider?.label ?? null,
    apiStatus: discovery.apiStatus,
    error: discovery.errors[0] ?? keyResult.error,
  });
  persistRealtimeRpcMetrics();
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
    const stream = startRaydiumTransactionStream((event) => { void ingestEvent(event); });
    try {
      while (!stopped && (runForMs === 0 || Date.now() - startedAt < runForMs)) {
        if (Date.now() - active.refreshedAt >= REFRESH_INTERVAL_MS) {
          try { await refreshActivePools(); } catch (error) {
            persistIndexerState("realtime.refresh_error", { error: error instanceof Error ? error.message : "实时池刷新失败", checkedAt: new Date().toISOString() });
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
