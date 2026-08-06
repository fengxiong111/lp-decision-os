import { type BackfillJobSnapshot, type BackfillPoolCursor, type EventWindowCoverage, type MinuteBucket, type SwapEventRecord } from "@/packages/models/src";
import { buildMinuteBuckets } from "@/services/indexer/buckets";
import { RAW_BACKFILL_HOURS, RAW_BACKFILL_JOB_ID, SHORT_WINDOWS, estimateEtaMs, isCursorComplete, progressForWindows, timeCoveragePercent, validateWindowProgress } from "@/services/indexer/progress";
import { discoverRwaUsdcPools } from "@/services/raydium/api";
import { fetchPoolKeys } from "@/services/raydium/keys";
import { getActiveRpcProvider, getRpcPoolSnapshot, hasConfiguredReliableRpc, parseProgramTransaction, rpcRequest, type HistoricalTransaction, type ProgramBackfillPool, type RpcProvider } from "@/services/rpc/pool";
import { getHttpMetricsSnapshot } from "@/services/shared/http";
import { getStorageMetricsSnapshot, persistBackfillFailures, persistBackfillJob, persistBackfillPoolCursors, persistIndexerState, persistMinuteBuckets, persistNormalizedSwaps, persistRpcTransactionCache, persistWindowCoverage, readBackfillFailures, readBackfillJob, readBackfillPoolCursors, readNormalizedSwaps, readRpcTransactionCache, type CachedRpcTransaction } from "@/services/storage/event-index";
import { mapWithConcurrency } from "@/services/shared/http";
import { classifyUniverseTiers, PRIORITY_SYMBOLS, selectTop20Pools } from "@/services/indexer/universe";

type SignatureItem = { signature: string; slot: number | null; blockTime: number | null; err: boolean };

type BackfillCycleResult = {
  discovery: Awaited<ReturnType<typeof discoverRwaUsdcPools>>;
  provider: RpcProvider | null;
  poolIds: string[];
  cursors: BackfillPoolCursor[];
  events: SwapEventRecord[];
  coverage: Record<string, Record<"1h" | "6h" | "12h", EventWindowCoverage>>;
  job: BackfillJobSnapshot;
};

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SIGNATURE_PAGE_LIMIT = Math.min(1_000, Math.max(1, Number(process.env.LP_BACKFILL_SIGNATURE_PAGE_LIMIT ?? 100)));
const MAX_POOLS_PER_CYCLE = Math.max(1, Number(process.env.LP_BACKFILL_MAX_POOLS_PER_CYCLE ?? 4));
const MAX_SIGNATURE_PAGES_PER_POOL_CYCLE = Math.max(1, Number(process.env.LP_BACKFILL_MAX_SIGNATURE_PAGES_PER_POOL_CYCLE ?? 1));
const STALLED_AFTER_MS = 5 * 60_000;
const MAX_RESTARTS = 3;

function assetSymbol(pool: Awaited<ReturnType<typeof discoverRwaUsdcPools>>["pools"][number]): string {
  return pool.mintA.address === USDC_MINT ? pool.mintB.symbol : pool.mintA.symbol;
}

function buildPriorityOrder(pools: Awaited<ReturnType<typeof discoverRwaUsdcPools>>["pools"]): string[] {
  const priority = new Set<string>(PRIORITY_SYMBOLS);
  const tierOne = pools.filter((pool) => priority.has(assetSymbol(pool)));
  const tierTwo = [...pools].sort((a, b) => (b.day.volume ?? 0) - (a.day.volume ?? 0)).slice(0, 20);
  const ordered = [...tierOne, ...tierTwo, ...pools];
  return [...new Set(ordered.map((pool) => pool.id))];
}

function knownPool(pool: Awaited<ReturnType<typeof discoverRwaUsdcPools>>["pools"][number], keys: Awaited<ReturnType<typeof fetchPoolKeys>>["keys"]): ProgramBackfillPool {
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

function emptyCursor(poolAddress: string, targetBlockTime: string): BackfillPoolCursor {
  return {
    poolAddress,
    oldestFetchedSignature: null,
    oldestFetchedBlockTime: null,
    oldestFetchedSlot: null,
    targetBlockTime,
    signaturesDiscovered: 0,
    transactionsFetched: 0,
    transactionsParsed: 0,
    transactionsFailed: 0,
    unknownInstructions: 0,
    lastProgressAt: null,
    retryCount: 0,
    status: "PENDING",
  };
}

function emptyJob(now: Date, targetPoolCount: number): BackfillJobSnapshot {
  const targetBlockTime = new Date(now.getTime() - RAW_BACKFILL_HOURS * 60 * 60_000).toISOString();
  return {
    jobId: RAW_BACKFILL_JOB_ID,
    targetWindow: "12h",
    targetBlockTime,
    startedAt: now.toISOString(),
    lastProgressAt: null,
    status: "RUNNING",
    targetPoolCount,
    completedPoolCount: 0,
    oldestCoveredAt: null,
    signaturesDiscovered: 0,
    transactionsFetched: 0,
    transactionsParsed: 0,
    transactionsFailed: 0,
    unknownInstructions: 0,
    requestsLast5m: 0,
    successfulTransactionsLast5m: 0,
    rpc429Last5m: 0,
    currentCursorTime: null,
    estimatedFinishAt: null,
    etaMs: null,
    restartCount: 0,
    blockedReason: null,
    progressHistory: [],
  };
}

function updateTargetTime(cursors: BackfillPoolCursor[], targetBlockTime: string): BackfillPoolCursor[] {
  return cursors.map((cursor) => ({ ...cursor, targetBlockTime }));
}

function repairStalledCursors(cursors: BackfillPoolCursor[], now: Date): { cursors: BackfillPoolCursor[]; restartCount: number; blocked: string[] } {
  let restartCount = 0;
  const blocked: string[] = [];
  const repaired = cursors.map((cursor) => {
    const stale = cursor.lastProgressAt !== null && now.getTime() - Date.parse(cursor.lastProgressAt) >= STALLED_AFTER_MS;
    if (!stale || (cursor.status !== "RUNNING" && cursor.status !== "STALLED")) return cursor;
    if (cursor.retryCount >= MAX_RESTARTS) {
      blocked.push(cursor.poolAddress);
      return { ...cursor, status: "BLOCKED" as const };
    }
    restartCount += 1;
    return { ...cursor, status: "PENDING" as const, retryCount: cursor.retryCount + 1 };
  });
  return { cursors: repaired, restartCount, blocked };
}

async function fetchPoolTransactions(provider: RpcProvider, items: SignatureItem[], now: Date): Promise<{ fetched: Map<string, { transaction: HistoricalTransaction | null; error: string | null }>; failed: number }> {
  // 不能只抓一页中的前 N 笔后把游标推进到整页末尾，否则会跳过未解析签名。
  // 先保证事实层不漏交易；吞吐由 RPC 3 RPS 和 worker 周期自然约束。
  const signatures = items;
  const cached = readRpcTransactionCache(signatures.map((item) => item.signature));
  const fetched = new Map<string, { transaction: HistoricalTransaction | null; error: string | null }>();
  const missing = signatures.filter((item) => {
    const row = cached.get(item.signature);
    if (!row) return true;
    if (row.status === "SUCCESS") {
      fetched.set(item.signature, { transaction: row.payload as HistoricalTransaction | null, error: null });
      return false;
    }
    return Date.parse(row.fetchedAt) < now.getTime() - 60_000;
  });
  const results = await mapWithConcurrency(missing, 3, async (item) => ({
    item,
    response: await rpcRequest<HistoricalTransaction>(provider, "getTransaction", [item.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }], 20_000),
  }));
  const cacheRows: CachedRpcTransaction[] = [];
  let failed = 0;
  for (const result of results) {
    const transaction = result.response.result;
    const error = result.response.error ?? (transaction ? null : "getTransaction 返回空");
    if (!transaction || error) failed += 1;
    fetched.set(result.item.signature, { transaction, error });
    cacheRows.push({ signature: result.item.signature, slot: transaction?.slot ?? result.item.slot, blockTime: transaction?.blockTime ?? result.item.blockTime, payload: transaction, status: transaction ? "SUCCESS" : "FAILED", error, fetchedAt: now.toISOString(), providerUrl: provider.url });
  }
  if (cacheRows.length > 0) persistRpcTransactionCache(cacheRows);
  return { fetched, failed };
}

function bucketWithPoolState(bucket: MinuteBucket, pool: Awaited<ReturnType<typeof discoverRwaUsdcPools>>["pools"][number], status: MinuteBucket["status"]): MinuteBucket {
  return { ...bucket, tvlStart: pool.tvl, tvlEnd: pool.tvl, activeTvl: pool.tvl, status };
}

function zeroBucket(pool: Awaited<ReturnType<typeof discoverRwaUsdcPools>>["pools"][number], start: Date, status: MinuteBucket["status"], asOf: string): MinuteBucket {
  return {
    poolId: pool.id,
    bucketStart: start.toISOString(),
    volumeUsd: 0,
    grossFeeUsd: 0,
    lpFeeUsd: 0,
    swapCount: 0,
    buyVolumeUsd: 0,
    sellVolumeUsd: 0,
    uniqueWalletCount: 0,
    tvlStart: pool.tvl,
    tvlEnd: pool.tvl,
    activeTvl: pool.tvl,
    feeDensity: 0,
    liquidityVelocity: 0,
    coverageRatio: 100,
    status,
    source: "normalized_swaps · complete zero-trade minute",
    asOf,
  };
}

function materializeMinuteBuckets(pools: Awaited<ReturnType<typeof discoverRwaUsdcPools>>["pools"], events: SwapEventRecord[], cursors: BackfillPoolCursor[], now: Date): MinuteBucket[] {
  const quoteMints = new Map(pools.map((pool) => [pool.id, USDC_MINT]));
  const generated = buildMinuteBuckets(events, now.toISOString(), "PARTIAL", quoteMints).map((bucket) => {
    const pool = pools.find((item) => item.id === bucket.poolId);
    const cursor = cursors.find((item) => item.poolAddress === bucket.poolId);
    return pool ? bucketWithPoolState(bucket, pool, cursor && isCursorComplete(cursor, new Date(cursor.targetBlockTime)) ? "COMPLETE" : "PARTIAL") : bucket;
  });
  const bucketKeys = new Set(generated.map((bucket) => `${bucket.poolId}:${bucket.bucketStart}`));
  const end = new Date(now);
  end.setUTCSeconds(0, 0);
  const start = new Date(end.getTime() - RAW_BACKFILL_HOURS * 60 * 60_000);
  for (const pool of pools) {
    const cursor = cursors.find((item) => item.poolAddress === pool.id);
    if (!cursor || !isCursorComplete(cursor, new Date(cursor.targetBlockTime))) continue;
    for (let time = new Date(start); time < end; time = new Date(time.getTime() + 60_000)) {
      const key = `${pool.id}:${time.toISOString()}`;
      if (!bucketKeys.has(key)) generated.push(zeroBucket(pool, time, "COMPLETE", now.toISOString()));
    }
  }
  return generated;
}

function coverageFromBuckets(pool: Awaited<ReturnType<typeof discoverRwaUsdcPools>>["pools"][number], cursor: BackfillPoolCursor, buckets: MinuteBucket[], now: Date): Record<"1h" | "6h" | "12h", EventWindowCoverage> {
  const result = {} as Record<"1h" | "6h" | "12h", EventWindowCoverage>;
  for (const window of SHORT_WINDOWS) {
    const end = new Date(now); end.setUTCSeconds(0, 0);
    const start = new Date(end.getTime() - ({ "1h": 60, "6h": 360, "12h": 720 }[window]) * 60_000);
    const selected = buckets.filter((bucket) => bucket.poolId === pool.id && Date.parse(bucket.bucketStart) >= start.getTime() && Date.parse(bucket.bucketStart) < end.getTime());
    const expected = ({ "1h": 60, "6h": 360, "12h": 720 }[window]);
    const observed = new Set(selected.map((bucket) => bucket.bucketStart)).size;
    const complete = isCursorComplete(cursor, new Date(cursor.targetBlockTime)) && observed === expected;
    const first = selected.at(-1);
    const last = selected[0];
    result[window] = {
      eventCount: selected.reduce((sum, bucket) => sum + bucket.swapCount, 0),
      poolCount: selected.some((bucket) => bucket.swapCount > 0) ? 1 : 0,
      firstSlot: null,
      lastSlot: null,
      firstEventAt: first?.bucketStart ?? null,
      lastEventAt: last?.bucketStart ?? null,
      completeness: complete ? 100 : timeCoveragePercent(cursor, window, now),
      persisted: selected.length > 0,
      source: "normalized_swaps → pool_metrics_1m",
      windowStart: start.toISOString(),
      windowEnd: end.toISOString(),
      startSlot: null,
      endSlot: null,
      expectedSlotRange: null,
      signaturesDiscovered: cursor.signaturesDiscovered,
      transactionsFetched: cursor.transactionsFetched,
      transactionsSuccessful: Math.max(0, cursor.transactionsFetched - cursor.transactionsFailed),
      transactionsFailed: cursor.transactionsFailed,
      swapsParsed: cursor.transactionsParsed,
      swapsRejected: cursor.unknownInstructions,
      duplicatesRemoved: 0,
      unknownInstructions: cursor.unknownInstructions,
      gapSlots: complete ? 0 : null,
      coverageRatio: complete ? 100 : timeCoveragePercent(cursor, window, now),
      firstEventTime: first?.bucketStart ?? null,
      lastEventTime: last?.bucketStart ?? null,
      backfillStatus: complete ? "COMPLETE" : cursor.status === "BLOCKED" ? "BLOCKED" : cursor.status === "STALLED" ? "STALLED" : "BACKFILLING",
    };
  }
  return result;
}

function updateJob(previous: BackfillJobSnapshot | null, cursors: BackfillPoolCursor[], targetBlockTime: string, now: Date, metrics: ReturnType<typeof getHttpMetricsSnapshot>, transactionSuccesses: number, restartCount: number, blocked: string[]): BackfillJobSnapshot {
  const completedPoolCount = cursors.filter((cursor) => isCursorComplete(cursor, new Date(targetBlockTime))).length;
  const targetPoolCount = cursors.length;
  const oldestCoveredAt = cursors.map((cursor) => cursor.oldestFetchedBlockTime).filter((value): value is string => Boolean(value)).sort().at(0) ?? null;
  const previousHistory = previous?.progressHistory ?? [];
  const transactionsFetched = cursors.reduce((sum, cursor) => sum + cursor.transactionsFetched, 0);
  const history = [...previousHistory, { at: now.toISOString(), completedPoolCount, oldestCoveredAt, transactionsFetched }].filter((sample) => Date.parse(sample.at) >= now.getTime() - 30 * 60_000).slice(-40);
  const etaMs = estimateEtaMs(history, completedPoolCount, targetPoolCount, now);
  const previousCompleted = previous?.completedPoolCount ?? 0;
  const progressed = completedPoolCount > previousCompleted || (oldestCoveredAt !== null && oldestCoveredAt !== previous?.oldestCoveredAt);
  const lastProgressAt = progressed ? now.toISOString() : previous?.lastProgressAt ?? now.toISOString();
  const noProgress = now.getTime() - Date.parse(lastProgressAt) >= STALLED_AFTER_MS;
  const status: BackfillJobSnapshot["status"] = blocked.length > 0
    ? "BLOCKED"
    : completedPoolCount === targetPoolCount && targetPoolCount > 0
      ? "LIVE"
      : noProgress ? "STALLED" : "RUNNING";
  return {
    jobId: RAW_BACKFILL_JOB_ID,
    targetWindow: "12h",
    targetBlockTime,
    startedAt: previous?.startedAt ?? now.toISOString(),
    lastProgressAt,
    status,
    targetPoolCount,
    completedPoolCount,
    oldestCoveredAt,
    signaturesDiscovered: cursors.reduce((sum, cursor) => sum + cursor.signaturesDiscovered, 0),
    transactionsFetched,
    transactionsParsed: cursors.reduce((sum, cursor) => sum + cursor.transactionsParsed, 0),
    transactionsFailed: cursors.reduce((sum, cursor) => sum + cursor.transactionsFailed, 0),
    unknownInstructions: cursors.reduce((sum, cursor) => sum + cursor.unknownInstructions, 0),
    requestsLast5m: metrics.requestsLast5m,
    successfulTransactionsLast5m: transactionSuccesses,
    rpc429Last5m: metrics.rateLimit429Last5m,
    currentCursorTime: cursors.map((cursor) => cursor.oldestFetchedBlockTime).filter((value): value is string => Boolean(value)).sort().at(0) ?? null,
    estimatedFinishAt: etaMs === null ? null : new Date(now.getTime() + etaMs).toISOString(),
    etaMs,
    restartCount: (previous?.restartCount ?? 0) + restartCount,
    blockedReason: blocked.length > 0 ? `${blocked.length} 个 Pool 连续无进度，已停止自动重试` : null,
    progressHistory: history,
  };
}

export async function runRawBackfillCycle(now = new Date()): Promise<BackfillCycleResult> {
  const discovery = await discoverRwaUsdcPools();
  // Public discovery remains complete; expensive historical RPC work is bounded
  // to the active decision universe so one slow tail pool cannot block the product.
  const targetDiscoveryPools = selectTop20Pools(discovery.pools);
  const universe = classifyUniverseTiers(discovery.pools);
  persistIndexerState("backfill.universe", {
    generatedAt: now.toISOString(),
    tier1: universe.tier1.map((pool) => pool.id),
    tier2: universe.tier2.map((pool) => pool.id),
    tier3: universe.tier3.map((pool) => pool.id),
    targetPoolIds: targetDiscoveryPools.map((pool) => pool.id),
    targetPolicy: "Tier 1 first; then active Tier 2; Tier 3 remains official-24h-only until requested",
  });
  const rpc = await getRpcPoolSnapshot();
  const provider = getActiveRpcProvider(rpc);
  const keys = provider ? await fetchPoolKeys(targetDiscoveryPools.map((pool) => pool.id)) : { keys: new Map() };
  const pools = targetDiscoveryPools.map((pool) => knownPool(pool, keys.keys));
  const targetBlockTime = new Date(now.getTime() - RAW_BACKFILL_HOURS * 60 * 60_000).toISOString();
  const savedJob = readBackfillJob(RAW_BACKFILL_JOB_ID);
  let job = savedJob && savedJob.targetPoolCount === pools.length ? savedJob : emptyJob(now, pools.length);
  if (job.status === "STOPPED" || job.status === "FAILED" || (job.status === "BLOCKED" && job.blockedReason === "未配置可靠 RPC；官方公共 RPC 仅作最后兜底")) {
    job = {
      ...job,
      targetBlockTime,
      targetPoolCount: pools.length,
      status: "RUNNING",
      lastProgressAt: now.toISOString(),
      blockedReason: null,
    };
  }
  // 长时间 getTransaction 回补开始前先写 RUNNING，页面不会在一个长 RPC 批次期间
  // 继续显示上一次已停止的任务。
  persistBackfillJob(job);
  persistIndexerState("backfill.raw_swaps_12h", job);
  const targetPoolIds = new Set(pools.map((pool) => pool.id));
  let cursors = readBackfillPoolCursors(RAW_BACKFILL_JOB_ID).filter((cursor) => targetPoolIds.has(cursor.poolAddress));
  const cursorById = new Map(cursors.map((cursor) => [cursor.poolAddress, cursor]));
  for (const pool of pools) if (!cursorById.has(pool.id)) cursorById.set(pool.id, emptyCursor(pool.id, targetBlockTime));
  cursors = updateTargetTime(pools.map((pool) => cursorById.get(pool.id) as BackfillPoolCursor), targetBlockTime);
  const repair = repairStalledCursors(cursors, now);
  cursors = repair.cursors;
  // 每个目标 Pool 都必须有自己的可恢复游标。只持久化当前 work slice 会让
  // 目标总数与 SQLite 游标数脱节，重启后也无法区分 PENDING 与未发现 Pool。
  persistBackfillPoolCursors(RAW_BACKFILL_JOB_ID, cursors);
  const order = buildPriorityOrder(targetDiscoveryPools);
  const cursorMap = new Map(cursors.map((cursor) => [cursor.poolAddress, cursor]));
  const work = order.map((id) => cursorMap.get(id)).filter((cursor): cursor is BackfillPoolCursor => cursor !== undefined && cursor.status !== "COMPLETE" && cursor.status !== "BLOCKED").slice(0, MAX_POOLS_PER_CYCLE);
  const poolById = new Map(pools.map((pool) => [pool.id, pool]));
  const eventBatch: SwapEventRecord[] = [];
  let transactionSuccesses = 0;
  const failures = [] as Array<{ jobId: string; poolAddress: string; signature: string | null; method: string; error: string; retryCount: number; firstSeenAt: string; lastSeenAt: string; resolvedAt: string | null }>;
  for (const cursor of work) {
    const pool = poolById.get(cursor.poolAddress);
    if (!pool || !provider) continue;
    const next: BackfillPoolCursor = { ...cursor, status: "RUNNING" };
    let before = next.oldestFetchedSignature ?? undefined;
    let pages = 0;
    let stop = false;
    while (pages < MAX_SIGNATURE_PAGES_PER_POOL_CYCLE && !stop) {
      const response = await rpcRequest<SignatureItem[]>(provider, "getSignaturesForAddress", [pool.id, { limit: SIGNATURE_PAGE_LIMIT, commitment: "confirmed", ...(before ? { before } : {}) }], 20_000);
      if (response.error) {
        next.status = "STALLED";
        next.retryCount += 1;
        failures.push({ jobId: RAW_BACKFILL_JOB_ID, poolAddress: pool.id, signature: before ?? null, method: "getSignaturesForAddress", error: response.error, retryCount: next.retryCount, firstSeenAt: now.toISOString(), lastSeenAt: now.toISOString(), resolvedAt: null });
        break;
      }
      const batch = (response.result ?? []).filter((item) => typeof item.signature === "string").map((item) => ({ signature: item.signature, slot: typeof item.slot === "number" ? item.slot : null, blockTime: typeof item.blockTime === "number" ? item.blockTime : null, err: Boolean(item.err) }));
      if (batch.length === 0) { next.status = "COMPLETE"; stop = true; break; }
      next.signaturesDiscovered += batch.length;
      const fetched = await fetchPoolTransactions(provider, batch.filter((item) => !item.err), now);
      next.transactionsFetched += fetched.fetched.size;
      next.transactionsFailed += fetched.failed;
      transactionSuccesses += fetched.fetched.size - fetched.failed;
      for (const item of batch.filter((item) => !item.err)) {
        const record = fetched.fetched.get(item.signature);
        if (!record?.transaction || record.error) continue;
        const parsed = parseProgramTransaction(pool, item.signature, record.transaction, now.toISOString());
        if (parsed.unknown) next.unknownInstructions += 1;
        if (parsed.event) { next.transactionsParsed += 1; eventBatch.push(parsed.event); }
      }
      const oldest = batch.at(-1);
      next.oldestFetchedSignature = oldest?.signature ?? next.oldestFetchedSignature;
      next.oldestFetchedBlockTime = oldest?.blockTime !== null && oldest?.blockTime !== undefined ? new Date(oldest.blockTime * 1000).toISOString() : next.oldestFetchedBlockTime;
      next.oldestFetchedSlot = oldest?.slot ?? next.oldestFetchedSlot;
      next.lastProgressAt = now.toISOString();
      before = oldest?.signature;
      pages += 1;
      if (!before || batch.length < SIGNATURE_PAGE_LIMIT || (oldest?.blockTime !== null && oldest?.blockTime !== undefined && oldest.blockTime * 1000 <= Date.parse(targetBlockTime))) {
        next.status = "COMPLETE";
        stop = true;
      }
    }
    if (next.status === "RUNNING" && next.oldestFetchedBlockTime && Date.parse(next.oldestFetchedBlockTime) <= Date.parse(targetBlockTime) && next.transactionsFailed === 0 && next.unknownInstructions === 0) next.status = "COMPLETE";
    cursorMap.set(pool.id, next);
    persistBackfillPoolCursors(RAW_BACKFILL_JOB_ID, [next]);
  }
  if (failures.length > 0) persistBackfillFailures(failures);
  cursors = pools.map((pool) => cursorMap.get(pool.id) as BackfillPoolCursor);
  persistBackfillPoolCursors(RAW_BACKFILL_JOB_ID, cursors);
  const allEvents = readNormalizedSwaps(pools.map((pool) => pool.id), new Date(now.getTime() - RAW_BACKFILL_HOURS * 60 * 60_000));
  if (eventBatch.length > 0) persistNormalizedSwaps(eventBatch, "raw-backfill-v2");
  const mergedEvents = [...new Map([...allEvents, ...eventBatch].map((event) => [`${event.signature}:${event.instructionIndex ?? 0}:${event.poolId}`, event])).values()];
  const buckets = materializeMinuteBuckets(targetDiscoveryPools, mergedEvents, cursors, now);
  persistMinuteBuckets(buckets);
  const httpMetrics = getHttpMetricsSnapshot();
  persistIndexerState("rpc.metrics", httpMetrics);
  persistIndexerState("rpc.metrics.backfill", httpMetrics);
  const nextJob = updateJob(job, cursors, targetBlockTime, now, httpMetrics, transactionSuccesses, repair.restartCount, repair.blocked);
  const windowProgress = progressForWindows(cursors, pools.length, now, nextJob);
  const assertion = validateWindowProgress(windowProgress);
  job = assertion.valid ? nextJob : { ...nextJob, status: "BACKFILL_PROGRESS_INVALID", blockedReason: assertion.reason };
  persistBackfillJob(job);
  persistIndexerState("backfill.raw_swaps_12h", job);
  persistIndexerState("backfill.diagnostics", { job, failures: readBackfillFailures(RAW_BACKFILL_JOB_ID, 50), storage: getStorageMetricsSnapshot(), rpc: httpMetrics, checkedAt: now.toISOString() });
  const coverage: Record<string, Record<"1h" | "6h" | "12h", EventWindowCoverage>> = Object.fromEntries(targetDiscoveryPools.map((pool) => [pool.id, coverageFromBuckets(pool, cursorMap.get(pool.id) as BackfillPoolCursor, buckets, now)]));
  persistWindowCoverage(coverage);
  return { discovery, provider, poolIds: pools.map((pool) => pool.id), cursors, events: mergedEvents, coverage, job };
}

export async function runBackfillWorker(): Promise<void> {
  const intervalMs = Math.max(30_000, Number(process.env.LP_BACKFILL_INTERVAL_MS ?? 60_000));
  const runForMs = Math.max(0, Number(process.env.LP_BACKFILL_RUN_FOR_MS ?? 0));
  const startedAt = Date.now();
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  persistIndexerState("worker.lifecycle.backfill", { status: "RUNNING", startedAt: new Date(startedAt).toISOString(), pid: process.pid });
  try {
    while (!stopped && (runForMs === 0 || Date.now() - startedAt < runForMs)) {
      if (!hasConfiguredReliableRpc() && process.env.LP_ALLOW_OFFICIAL_BACKFILL !== "1") {
        const job = readBackfillJob(RAW_BACKFILL_JOB_ID);
        if (job && job.status !== "LIVE" && (job.status !== "BLOCKED" || job.blockedReason !== "未配置可靠 RPC；官方公共 RPC 仅作最后兜底")) {
          persistBackfillJob({ ...job, status: "BLOCKED", blockedReason: "未配置可靠 RPC；官方公共 RPC 仅作最后兜底", lastProgressAt: new Date().toISOString() });
        }
        persistIndexerState("backfill.blocked", { status: "BLOCKED", reason: "未配置可靠 RPC；官方公共 RPC 仅作最后兜底", checkedAt: new Date().toISOString() });
      } else {
        try { await runRawBackfillCycle(); } catch (error) {
        persistIndexerState("backfill.error", { detail: error instanceof Error ? error.message : "raw 12h 回补失败", checkedAt: new Date().toISOString() });
        }
      }
      if (!stopped) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } finally {
    const job = readBackfillJob(RAW_BACKFILL_JOB_ID);
    if (job && job.status !== "LIVE") persistBackfillJob({ ...job, status: "STOPPED" });
    persistIndexerState("worker.lifecycle.backfill", { status: "STOPPED", startedAt: new Date(startedAt).toISOString(), stoppedAt: new Date().toISOString(), pid: process.pid });
  }
}
