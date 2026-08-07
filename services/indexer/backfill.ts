import { createHash } from "node:crypto";
import { type BackfillJobSnapshot, type BackfillPoolCursor, type EventWindowCoverage, type MinuteBucket, type SwapErrorCategory, type SwapEventRecord, type TransactionClassification } from "@/packages/models/src";
import { buildMinuteBuckets } from "@/services/indexer/buckets";
import { EXPECTED_BUCKET_COUNTS, RAW_BACKFILL_HOURS, RAW_BACKFILL_JOB_ID, SHORT_WINDOWS, deterministicWindowComplete, estimateEtaMs, progressForWindows, validateWindowProgress } from "@/services/indexer/progress";
import { discoverRwaUsdcPools } from "@/services/raydium/api";
import { fetchPoolKeys } from "@/services/raydium/keys";
import { getActiveRpcProvider, getRpcPoolSnapshot, parseProgramTransaction, rpcRequest, type HistoricalTransaction, type ProgramBackfillPool, type RpcProvider } from "@/services/rpc/pool";
import { getHttpMetricsSnapshot } from "@/services/shared/http";
import { getStorageMetricsSnapshot, persistBackfillFailures, persistBackfillJob, persistBackfillPoolCursors, persistIndexerState, persistMinuteBuckets, persistNormalizedSwaps, persistRawTransactions, persistRpcTransactionCache, persistTransactionClassifications, persistWindowCoverage, readBackfillFailures, readBackfillJob, readBackfillPoolCursors, readIndexerState, readNormalizedSwaps, readParserFunnel, readRawTransactions, readRetryableRawTransactions, readRpcTransactionCache, readUnresolvedRetryableTransactions, reclassifyRpcFailureRecords, type CachedRpcTransaction, type RawTransactionCacheEntry } from "@/services/storage/event-index";
import { mapWithConcurrency } from "@/services/shared/http";
import { classifyUniverseTiers, PRIORITY_SYMBOLS } from "@/services/indexer/universe";
import { evaluateUniverseExpansion, runPoolAdmissionFixtureCycle, selectShortWindowPools } from "@/services/indexer/expansion";

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
const MAX_POOLS_PER_CYCLE = Math.min(5, Math.max(1, Number(process.env.LP_BACKFILL_MAX_POOLS_PER_CYCLE ?? 5)));
const MAX_SIGNATURE_PAGES_PER_POOL_CYCLE = Math.max(1, Number(process.env.LP_BACKFILL_MAX_SIGNATURE_PAGES_PER_POOL_CYCLE ?? 1));
const STALLED_AFTER_MS = 5 * 60_000;
const MAX_RESTARTS = 3;
const PARSER_VERSION = "raydium-swap-parser-v2";
type BackfillThrottleStatus = "CONTINUE" | "THROTTLED" | "PAUSED";
type BackfillThrottle = {
  status: BackfillThrottleStatus;
  window: "last30m";
  requests: number;
  rateLimit429: number;
  rateLimit429Ratio: number | null;
  historicalBackfill: "RUNNING" | "REDUCED" | "PAUSED";
  realtimePriority: "REALTIME_FIRST";
  reason: string | null;
  checkedAt: string;
};

function decideBackfillThrottle(metrics: ReturnType<typeof getHttpMetricsSnapshot>, now: Date): BackfillThrottle {
  const recent = metrics.rpcFailureStats.last30m;
  const ratio = recent.requests > 0 ? recent.rateLimit429 / recent.requests : null;
  const status: BackfillThrottleStatus = ratio !== null && ratio > 0.10 ? "PAUSED" : ratio !== null && ratio > 0.05 ? "THROTTLED" : "CONTINUE";
  return {
    status,
    window: "last30m",
    requests: recent.requests,
    rateLimit429: recent.rateLimit429,
    rateLimit429Ratio: ratio,
    historicalBackfill: status === "PAUSED" ? "PAUSED" : status === "THROTTLED" ? "REDUCED" : "RUNNING",
    realtimePriority: "REALTIME_FIRST",
    reason: status === "PAUSED"
      ? `RPC_429_RATE_${ratio === null ? "UNKNOWN" : (ratio * 100).toFixed(2)}%_LAST30M：历史回补已暂停，仅保留实时监听；需要备用 RPC`
      : status === "THROTTLED"
        ? `RPC_429_RATE_${ratio === null ? "UNKNOWN" : (ratio * 100).toFixed(2)}%_LAST30M：历史回补降速，实时监听优先`
        : null,
    checkedAt: now.toISOString(),
  };
}
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

function fetchError(error: string): { category: SwapErrorCategory; retryable: boolean; code: string } {
  const normalized = error.toLowerCase();
  if (normalized.includes("429")) return { category: "RPC_429", retryable: true, code: "HTTP_429" };
  if (normalized.includes("timeout") || normalized.includes("timed out") || normalized.includes("abort")) return { category: "RPC_TIMEOUT", retryable: true, code: "RPC_TIMEOUT" };
  if (normalized.includes("熔断") || normalized.includes("network") || normalized.includes("fetch") || normalized.includes("连接")) return { category: "RPC_NETWORK_ERROR", retryable: true, code: "RPC_NETWORK_ERROR" };
  if (normalized.includes("version") || normalized.includes("maxsupportedtransactionversion")) return { category: "TRANSACTION_VERSION_UNSUPPORTED", retryable: false, code: "TRANSACTION_VERSION_UNSUPPORTED" };
  if (normalized.includes("lookup") || normalized.includes("address table")) return { category: "ADDRESS_LOOKUP_TABLE_FAILED", retryable: false, code: "ADDRESS_LOOKUP_TABLE_FAILED" };
  if (normalized.includes("返回空") || normalized.includes("not available") || normalized.includes("不存在")) return { category: "TRANSACTION_NOT_AVAILABLE", retryable: false, code: "TRANSACTION_NOT_AVAILABLE" };
  return { category: "RPC_NETWORK_ERROR", retryable: true, code: "RPC_REQUEST_FAILED" };
}

function rawEntry(
  item: SignatureItem,
  transaction: HistoricalTransaction | null,
  error: string | null,
  provider: RpcProvider,
  now: Date,
  previous?: RawTransactionCacheEntry,
): RawTransactionCacheEntry {
  const transactionJson = transaction === null ? null : JSON.stringify(transaction);
  const failure = error ? fetchError(error) : null;
  const timestamp = now.toISOString();
  return {
    signature: item.signature,
    slot: transaction?.slot ?? item.slot,
    blockTime: transaction?.blockTime ?? item.blockTime,
    transactionJson,
    fetchStatus: transaction && !error ? "SUCCESS" : "FAILED",
    fetchedAt: timestamp,
    rpcEndpoint: provider.url,
    sha256: transactionJson === null ? null : createHash("sha256").update(transactionJson).digest("hex"),
    errorCategory: failure?.category ?? null,
    errorCode: failure?.code ?? null,
    errorMessage: error,
    retryable: failure?.retryable ?? false,
    attemptCount: (previous?.attemptCount ?? 0) + 1,
    firstSeenAt: previous?.firstSeenAt ?? timestamp,
    lastAttemptAt: timestamp,
    parserVersion: PARSER_VERSION,
  };
}

function fetchClassification(pool: ProgramBackfillPool, item: SignatureItem, error: string, now: Date): TransactionClassification {
  const failure = fetchError(error);
  const timestamp = now.toISOString();
  return {
    signature: item.signature,
    slot: item.slot,
    blockTime: item.blockTime,
    poolAddress: pool.id,
    programId: pool.programId,
    transactionVersion: null,
    errorCategory: failure.category,
    errorCode: failure.code,
    errorMessage: error,
    retryable: failure.retryable,
    attemptCount: 1,
    firstSeenAt: timestamp,
    lastAttemptAt: timestamp,
    rawTransactionPath: `sqlite://raw_transactions/${item.signature}`,
    parserVersion: PARSER_VERSION,
    instructionIndex: null,
    discriminator: null,
    accountCount: null,
  };
}

async function fetchPoolTransactions(provider: RpcProvider, items: SignatureItem[], now: Date): Promise<{ fetched: Map<string, { transaction: HistoricalTransaction | null; error: string | null }>; failed: number }> {
  // 不能只抓一页中的前 N 笔后把游标推进到整页末尾，否则会跳过未解析签名。
  // 先保证事实层不漏交易；吞吐由 RPC 3 RPS 和 worker 周期自然约束。
  const signatures = items;
  const uniqueItems = [...new Map(signatures.map((item) => [item.signature, item])).values()];
  const cached = readRpcTransactionCache(uniqueItems.map((item) => item.signature));
  const rawCached = readRawTransactions(uniqueItems.map((item) => item.signature));
  const fetched = new Map<string, { transaction: HistoricalTransaction | null; error: string | null }>();
  const rawRows: RawTransactionCacheEntry[] = [];
  const missing = uniqueItems.filter((item) => {
    const row = cached.get(item.signature);
    const raw = rawCached.get(item.signature);
    if (raw?.fetchStatus === "SUCCESS" && raw.transactionJson) {
      try {
        fetched.set(item.signature, { transaction: JSON.parse(raw.transactionJson) as HistoricalTransaction, error: null });
        return false;
      } catch {
        // raw JSON 损坏时继续检查 legacy cache/RPC，不能静默当作成功。
      }
    }
    // 永久失败没有新的外部状态可改变；无论 legacy cache 是否存在都不得
    // 因为游标再次请求同一签名。
    if (raw && !raw.retryable) {
      fetched.set(item.signature, { transaction: null, error: raw.errorMessage ?? row?.error ?? "交易获取失败" });
      return false;
    }
    if (!row) return true;
    if (row.status === "SUCCESS") {
      fetched.set(item.signature, { transaction: row.payload as HistoricalTransaction | null, error: null });
      if (!raw) rawRows.push(rawEntry(item, row.payload as HistoricalTransaction | null, null, provider, now));
      return false;
    }
    return Date.parse(row.fetchedAt) < now.getTime() - 60_000;
  });
  const results = await mapWithConcurrency(missing, 1, async (item) => ({
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
    rawRows.push(rawEntry(result.item, transaction, error, provider, now, rawCached.get(result.item.signature)));
  }
  if (cacheRows.length > 0) persistRpcTransactionCache(cacheRows);
  if (rawRows.length > 0) persistRawTransactions(rawRows);
  return { fetched, failed };
}

function consumeFetchedTransactions(
  pool: ProgramBackfillPool,
  items: SignatureItem[],
  fetched: Map<string, { transaction: HistoricalTransaction | null; error: string | null }>,
  now: Date,
): { classifications: TransactionClassification[]; events: SwapEventRecord[]; parsedCount: number; unknownCount: number; successfulCount: number } {
  const classifications: TransactionClassification[] = [];
  const events: SwapEventRecord[] = [];
  let parsedCount = 0;
  let unknownCount = 0;
  let successfulCount = 0;
  for (const item of items) {
    if (item.err) {
      const parsedFailed = parseProgramTransaction(pool, item.signature, { slot: item.slot ?? undefined, blockTime: item.blockTime ?? undefined, meta: { err: { source: "getSignaturesForAddress" } } }, now.toISOString());
      classifications.push(...parsedFailed.classifications);
      continue;
    }
    const record = fetched.get(item.signature);
    if (!record?.transaction || record.error) {
      if (record?.error) classifications.push(fetchClassification(pool, item, record.error, now));
      continue;
    }
    successfulCount += 1;
    const parsed = parseProgramTransaction(pool, item.signature, record.transaction, now.toISOString());
    classifications.push(...parsed.classifications);
    if (parsed.classifications.some((classification) => classification.errorCategory === "INSTRUCTION_DISCRIMINATOR_UNKNOWN")) unknownCount += 1;
    if (parsed.events.length > 0) {
      parsedCount += 1;
      events.push(...parsed.events);
    }
  }
  return { classifications, events, parsedCount, unknownCount, successfulCount };
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
  const end = new Date(now);
  end.setUTCSeconds(0, 0);
  const windowStart = (window: "1h" | "6h" | "12h") => new Date(end.getTime() - EXPECTED_BUCKET_COUNTS[window] * 60_000);
  const cursorByPool = new Map(cursors.map((cursor) => [cursor.poolAddress, cursor]));
  const prerequisites = (poolId: string, window: "1h" | "6h" | "12h") => {
    const cursor = cursorByPool.get(poolId);
    if (!cursor?.oldestFetchedBlockTime) return false;
    const unresolved = readUnresolvedRetryableTransactions(poolId, windowStart(window));
    return Date.parse(cursor.oldestFetchedBlockTime) <= windowStart(window).getTime() && unresolved === 0;
  };
  const bucketStatus = (poolId: string, bucketStart: string): MinuteBucket["status"] => {
    const timestamp = Date.parse(bucketStart);
    if (timestamp >= windowStart("1h").getTime() && prerequisites(poolId, "1h")) return "COMPLETE";
    if (timestamp >= windowStart("6h").getTime() && prerequisites(poolId, "6h")) return "COMPLETE";
    if (timestamp >= windowStart("12h").getTime() && prerequisites(poolId, "12h")) return "COMPLETE";
    return "PARTIAL";
  };
  const generated = buildMinuteBuckets(events, now.toISOString(), "PARTIAL", quoteMints).map((bucket) => {
    const pool = pools.find((item) => item.id === bucket.poolId);
    return pool ? bucketWithPoolState(bucket, pool, bucketStatus(bucket.poolId, bucket.bucketStart)) : bucket;
  });
  const bucketKeys = new Set(generated.map((bucket) => `${bucket.poolId}:${bucket.bucketStart}`));
  const start = new Date(end.getTime() - RAW_BACKFILL_HOURS * 60 * 60_000);
  for (const pool of pools) {
    // 每个窗口独立零填充。1h 达标不等待 6h/12h；无成交分钟仍然是可审计的真实 0。
    for (const window of SHORT_WINDOWS) {
      if (!prerequisites(pool.id, window)) continue;
      const rangeStart = windowStart(window);
      for (let time = new Date(rangeStart); time < end; time = new Date(time.getTime() + 60_000)) {
        const key = `${pool.id}:${time.toISOString()}`;
        if (!bucketKeys.has(key)) {
          generated.push(zeroBucket(pool, time, "COMPLETE", now.toISOString()));
          bucketKeys.add(key);
        }
      }
    }
    // 保留 12h 之前已有的事实桶，不在本轮扩展历史范围。
    for (let time = new Date(start); time < end; time = new Date(time.getTime() + 60_000)) {
      const key = `${pool.id}:${time.toISOString()}`;
      const item = generated.find((bucket) => `${bucket.poolId}:${bucket.bucketStart}` === key);
      if (item && item.status !== "COMPLETE") item.status = bucketStatus(pool.id, item.bucketStart);
    }
  }
  return generated;
}

function coverageFromBuckets(pool: Awaited<ReturnType<typeof discoverRwaUsdcPools>>["pools"][number], cursor: BackfillPoolCursor, buckets: MinuteBucket[], now: Date): Record<"1h" | "6h" | "12h", EventWindowCoverage> {
  const result = {} as Record<"1h" | "6h" | "12h", EventWindowCoverage>;
  for (const window of SHORT_WINDOWS) {
    const end = new Date(now); end.setUTCSeconds(0, 0);
    const expected = EXPECTED_BUCKET_COUNTS[window];
    const start = new Date(end.getTime() - expected * 60_000);
    const selected = buckets.filter((bucket) => bucket.poolId === pool.id && Date.parse(bucket.bucketStart) >= start.getTime() && Date.parse(bucket.bucketStart) < end.getTime());
    const observed = new Set(selected.map((bucket) => bucket.bucketStart)).size;
    const unresolvedRetryableTransactions = readUnresolvedRetryableTransactions(pool.id, start);
    const gapCount = Math.max(0, expected - observed);
    const complete = deterministicWindowComplete({
      window,
      windowStart: start.toISOString(),
      oldestCoveredBlockTime: cursor.oldestFetchedBlockTime,
      unresolvedRetryableTransactions,
      gapCount,
      metricsBucketCount: observed,
    });
    const partialCoverage = Math.min(100, (observed / expected) * 100);
    const first = selected.at(-1);
    const last = selected[0];
    result[window] = {
      eventCount: selected.reduce((sum, bucket) => sum + bucket.swapCount, 0),
      poolCount: selected.some((bucket) => bucket.swapCount > 0) ? 1 : 0,
      firstSlot: null,
      lastSlot: null,
      firstEventAt: first?.bucketStart ?? null,
      lastEventAt: last?.bucketStart ?? null,
      completeness: partialCoverage,
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
      swapsParsed: selected.reduce((sum, bucket) => sum + bucket.swapCount, 0),
      swapsRejected: cursor.unknownInstructions,
      duplicatesRemoved: 0,
      unknownInstructions: cursor.unknownInstructions,
      gapSlots: complete ? 0 : gapCount,
      coverageRatio: complete ? 100 : partialCoverage,
      firstEventTime: first?.bucketStart ?? null,
      lastEventTime: last?.bucketStart ?? null,
      backfillStatus: complete ? "COMPLETE" : cursor.status === "BLOCKED" ? "BLOCKED" : cursor.status === "STALLED" ? "STALLED" : "BACKFILLING",
      expectedBucketCount: expected,
      metricsBucketCount: observed,
      unresolvedRetryableTransactions,
      gapCount,
      oldestCoveredBlockTime: cursor.oldestFetchedBlockTime,
    };
  }
  return result;
}

function updateJob(previous: BackfillJobSnapshot | null, cursors: BackfillPoolCursor[], targetBlockTime: string, now: Date, metrics: ReturnType<typeof getHttpMetricsSnapshot>, transactionSuccesses: number, restartCount: number, blocked: string[], pauseReason: string | null): BackfillJobSnapshot {
  const completedPoolCount = cursors.filter((cursor) => cursor.status === "COMPLETE" && cursor.oldestFetchedBlockTime !== null && Date.parse(cursor.oldestFetchedBlockTime) <= Date.parse(targetBlockTime) && readUnresolvedRetryableTransactions(cursor.poolAddress, new Date(targetBlockTime)) === 0).length;
  const targetPoolCount = cursors.length;
  const oldestCoveredAt = cursors.map((cursor) => cursor.oldestFetchedBlockTime).filter((value): value is string => Boolean(value)).sort().at(0) ?? null;
  const previousHistory = previous?.progressHistory ?? [];
  const signaturesDiscovered = cursors.reduce((sum, cursor) => sum + cursor.signaturesDiscovered, 0);
  const transactionsFetched = cursors.reduce((sum, cursor) => sum + cursor.transactionsFetched, 0);
  const history = [...previousHistory, { at: now.toISOString(), completedPoolCount, oldestCoveredAt, transactionsFetched }].filter((sample) => Date.parse(sample.at) >= now.getTime() - 30 * 60_000).slice(-40);
  const etaMs = estimateEtaMs(history, completedPoolCount, targetPoolCount, now);
  const previousCompleted = previous?.completedPoolCount ?? 0;
  const progressed = completedPoolCount > previousCompleted
    || (oldestCoveredAt !== null && oldestCoveredAt !== previous?.oldestCoveredAt)
    || transactionsFetched > (previous?.transactionsFetched ?? 0)
    || signaturesDiscovered > (previous?.signaturesDiscovered ?? 0);
  const lastProgressAt = progressed ? now.toISOString() : previous?.lastProgressAt ?? now.toISOString();
  const noProgress = now.getTime() - Date.parse(lastProgressAt) >= STALLED_AFTER_MS;
  const status: BackfillJobSnapshot["status"] = pauseReason !== null
    ? "BLOCKED"
    : blocked.length > 0
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
    signaturesDiscovered,
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
    blockedReason: pauseReason ?? (blocked.length > 0 ? `${blocked.length} 个 Pool 连续无进度，已停止自动重试` : null),
    progressHistory: history,
  };
}

export async function runRawBackfillCycle(now = new Date()): Promise<BackfillCycleResult> {
  const discovery = await discoverRwaUsdcPools();
  // The expansion state is the only authority allowed to enlarge the short
  // window target. A failed gate immediately returns the two-pool baseline.
  let expansion = evaluateUniverseExpansion(discovery.pools, discovery.universe, now);
  const universe = classifyUniverseTiers(discovery.pools, discovery.universe);
  const rpc = await getRpcPoolSnapshot();
  persistIndexerState("rpc.pool", rpc);
  const provider = getActiveRpcProvider(rpc);
  if (expansion.stage === "STAGE_B") {
    await runPoolAdmissionFixtureCycle({ pools: discovery.pools, state: expansion, provider, now });
    expansion = evaluateUniverseExpansion(discovery.pools, discovery.universe, now);
  }
  // Public discovery remains complete. Only baseline pools and admitted Tier1
  // onboarding pools can consume full historical RPC work.
  const targetDiscoveryPools = selectShortWindowPools(discovery.pools, expansion);
  persistIndexerState("backfill.universe", {
    generatedAt: now.toISOString(),
    tier1: expansion.tier1PoolIds,
    tier2: expansion.tier2PoolIds,
    tier3: universe.tier3.map((pool) => pool.id),
    researchTier1: universe.tier1.map((pool) => pool.id),
    researchTier2: universe.tier2.map((pool) => pool.id),
    targetPoolIds: targetDiscoveryPools.map((pool) => pool.id),
    expansionStage: expansion.stage,
    targetPolicy: expansion.stage === "STAGE_B"
      ? "STAGE_B：SPCX/SPCXx 基线 + 仅 Tier1 通过身份、Program、Fee、20笔fixture和解析门槛的Pool；Tier2保留官方24h并低频监听"
      : "STAGE_A：仅 SPCX/USDC 0.25% 与 SPCXx/USDC 0.8% 消耗历史 RPC；其它 Pool 保留现有数据与官方24h数据",
    targetSymbols: targetDiscoveryPools.map((pool) => assetSymbol(pool)),
  });
  const keys = provider ? await fetchPoolKeys(targetDiscoveryPools.map((pool) => pool.id)) : { keys: new Map() };
  const pools = targetDiscoveryPools.map((pool) => knownPool(pool, keys.keys));
  const targetBlockTime = new Date(now.getTime() - RAW_BACKFILL_HOURS * 60 * 60_000).toISOString();
  const throttle = decideBackfillThrottle(getHttpMetricsSnapshot(), now);
  persistIndexerState("backfill.throttle", throttle);
  const savedJob = readBackfillJob(RAW_BACKFILL_JOB_ID);
  let job = savedJob && savedJob.targetPoolCount === pools.length ? savedJob : emptyJob(now, pools.length);
  if (job.status === "STOPPED" || job.status === "FAILED" || (job.status === "BLOCKED" && (job.blockedReason === "未配置可靠 RPC；官方公共 RPC 仅作最后兜底" || job.blockedReason?.startsWith("RPC_429_RATE_")))) {
    job = {
      ...job,
      targetBlockTime,
      targetPoolCount: pools.length,
      status: "RUNNING",
      lastProgressAt: now.toISOString(),
      blockedReason: null,
    };
  }
  if (throttle.status === "PAUSED" && job.completedPoolCount < pools.length) {
    job = { ...job, status: "BLOCKED", blockedReason: throttle.reason };
  }
  // 长时间 getTransaction 回补开始前先写 RUNNING，页面不会在一个长 RPC 批次期间
  // 继续显示上一次已停止的任务。
  persistBackfillJob(job);
  persistIndexerState("backfill.raw_swaps_12h", job);
  const targetPoolIds = new Set(pools.map((pool) => pool.id));
  if (!readIndexerState("rpc.failure_reclassification")) {
    persistIndexerState("rpc.failure_reclassification", {
      completedAt: now.toISOString(),
      scope: "raw_transactions + transaction_classifications",
      categories: reclassifyRpcFailureRecords(),
    });
  }
  let cursors = readBackfillPoolCursors(RAW_BACKFILL_JOB_ID).filter((cursor) => targetPoolIds.has(cursor.poolAddress));
  const cursorById = new Map(cursors.map((cursor) => [cursor.poolAddress, cursor]));
  for (const pool of pools) if (!cursorById.has(pool.id)) cursorById.set(pool.id, emptyCursor(pool.id, targetBlockTime));
  cursors = updateTargetTime(pools.map((pool) => cursorById.get(pool.id) as BackfillPoolCursor), targetBlockTime);
  const repair = repairStalledCursors(cursors, now);
  const recoveryState = readIndexerState<{ parserVersion?: string }>("backfill.parser_recovery");
  const resetLegacyRecoveryCursors = recoveryState?.parserVersion !== PARSER_VERSION;
  cursors = resetLegacyRecoveryCursors
    ? repair.cursors.map((cursor) => ({ ...cursor, retryCount: 0, unknownInstructions: 0, status: cursor.status === "BLOCKED" || cursor.status === "STALLED" ? "PENDING" as const : cursor.status }))
    : repair.cursors;
  // 旧版本可能把失败批次错误标成 COMPLETE；重启时先按可重试交易重新打开。
  cursors = cursors.map((cursor) => {
    const unresolved = readUnresolvedRetryableTransactions(cursor.poolAddress, new Date(targetBlockTime));
    return cursor.status === "COMPLETE" && unresolved > 0 ? { ...cursor, status: "RUNNING" as const } : cursor;
  });
  if (resetLegacyRecoveryCursors) persistIndexerState("backfill.parser_recovery", { parserVersion: PARSER_VERSION, resetAt: now.toISOString(), targetPoolIds: pools.map((pool) => pool.id) });
  // 每个目标 Pool 都必须有自己的可恢复游标。只持久化当前 work slice 会让
  // 目标总数与 SQLite 游标数脱节，重启后也无法区分 PENDING 与未发现 Pool。
  persistBackfillPoolCursors(RAW_BACKFILL_JOB_ID, cursors);
  const order = buildPriorityOrder(targetDiscoveryPools);
  const cursorMap = new Map(cursors.map((cursor) => [cursor.poolAddress, cursor]));
  const work = throttle.status === "PAUSED"
    ? []
    : order.map((id) => cursorMap.get(id)).filter((cursor): cursor is BackfillPoolCursor => cursor !== undefined && cursor.status !== "COMPLETE" && cursor.status !== "BLOCKED").slice(0, MAX_POOLS_PER_CYCLE);
  const cycleSignaturePageLimit = throttle.status === "THROTTLED" ? Math.max(25, Math.floor(SIGNATURE_PAGE_LIMIT / 2)) : SIGNATURE_PAGE_LIMIT;
  const poolById = new Map(pools.map((pool) => [pool.id, pool]));
  const eventBatch: SwapEventRecord[] = [];
  const classificationBatch: TransactionClassification[] = [];
  let transactionSuccesses = 0;
  const failures = [] as Array<{ jobId: string; poolAddress: string; signature: string | null; method: string; error: string; retryCount: number; firstSeenAt: string; lastSeenAt: string; resolvedAt: string | null }>;
  for (const cursor of work) {
    const pool = poolById.get(cursor.poolAddress);
    if (!pool || !provider) continue;
    const next: BackfillPoolCursor = { ...cursor, status: "RUNNING" };
    let before = next.oldestFetchedSignature ?? undefined;
    let pages = 0;
    let stop = false;
    // 失败签名不一定会再次出现在 signatures 分页中：游标已经越过它们时，
    // 仍必须先从 raw cache 重试，直到成功或被明确标记为永久失败。
    const retryableRows = readRetryableRawTransactions(pool.id, new Date(targetBlockTime));
    if (retryableRows.length > 0) {
      const retryItems = retryableRows.map((row) => ({ signature: row.signature, slot: row.slot, blockTime: row.blockTime, err: false }));
      const retried = await fetchPoolTransactions(provider, retryItems, now);
      const consumed = consumeFetchedTransactions(pool, retryItems, retried.fetched, now);
      classificationBatch.push(...consumed.classifications);
      eventBatch.push(...consumed.events);
      next.transactionsFailed = Math.max(0, next.transactionsFailed - consumed.successfulCount);
      next.transactionsParsed += consumed.parsedCount;
      next.unknownInstructions += consumed.unknownCount;
      transactionSuccesses += consumed.successfulCount;
    }
    while (pages < MAX_SIGNATURE_PAGES_PER_POOL_CYCLE && !stop) {
      const response = await rpcRequest<SignatureItem[]>(provider, "getSignaturesForAddress", [pool.id, { limit: cycleSignaturePageLimit, commitment: "confirmed", ...(before ? { before } : {}) }], 20_000);
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
      const consumed = consumeFetchedTransactions(pool, batch, fetched.fetched, now);
      classificationBatch.push(...consumed.classifications);
      eventBatch.push(...consumed.events);
      transactionSuccesses += consumed.successfulCount;
      next.unknownInstructions += consumed.unknownCount;
      next.transactionsParsed += consumed.parsedCount;
      const oldest = batch.at(-1);
      next.oldestFetchedSignature = oldest?.signature ?? next.oldestFetchedSignature;
      next.oldestFetchedBlockTime = oldest?.blockTime !== null && oldest?.blockTime !== undefined ? new Date(oldest.blockTime * 1000).toISOString() : next.oldestFetchedBlockTime;
      next.oldestFetchedSlot = oldest?.slot ?? next.oldestFetchedSlot;
      next.lastProgressAt = now.toISOString();
      before = oldest?.signature;
      pages += 1;
      if (!before || batch.length < cycleSignaturePageLimit || (oldest?.blockTime !== null && oldest?.blockTime !== undefined && oldest.blockTime * 1000 <= Date.parse(targetBlockTime))) {
        // 先停止本轮分页；是否 COMPLETE 要等分类写入后按 retryable 事实判定。
        next.status = "RUNNING";
        stop = true;
      }
    }
    // retryable 失败会在本轮分类落库后再次核对；这里只保留 RUNNING，避免
    // “游标越过目标时间但 429 尚未解决”被误报为完成。
    cursorMap.set(pool.id, next);
    persistBackfillPoolCursors(RAW_BACKFILL_JOB_ID, [next]);
  }
  if (failures.length > 0) persistBackfillFailures(failures);
  if (classificationBatch.length > 0) persistTransactionClassifications(classificationBatch);
  for (const [poolId, cursor] of cursorMap) {
    if (cursor.status === "BLOCKED" || cursor.status === "STALLED") continue;
    const reachedTarget = cursor.oldestFetchedBlockTime !== null && Date.parse(cursor.oldestFetchedBlockTime) <= Date.parse(targetBlockTime);
    const unresolved = readUnresolvedRetryableTransactions(poolId, new Date(targetBlockTime));
    cursor.status = reachedTarget && unresolved === 0 ? "COMPLETE" : "RUNNING";
  }
  cursors = pools.map((pool) => cursorMap.get(pool.id) as BackfillPoolCursor);
  persistBackfillPoolCursors(RAW_BACKFILL_JOB_ID, cursors);
  const resumeEvidence = readIndexerState<{ verified?: boolean; cursorRegression?: boolean; cursorWatermarks?: Record<string, { blockTime: string | null; slot: number | null }> }>("backfill.resume");
  const cycleCursorRegression = cursors.some((cursor) => {
    const previous = resumeEvidence?.cursorWatermarks?.[cursor.poolAddress];
    if (!previous) return false;
    const currentTime = cursor.oldestFetchedBlockTime ? Date.parse(cursor.oldestFetchedBlockTime) : null;
    const previousTime = previous.blockTime ? Date.parse(previous.blockTime) : null;
    return (currentTime !== null && previousTime !== null && Number.isFinite(currentTime) && Number.isFinite(previousTime) && currentTime > previousTime)
      || (cursor.oldestFetchedSlot !== null && previous.slot !== null && cursor.oldestFetchedSlot > previous.slot);
  });
  persistIndexerState("backfill.resume", {
    ...resumeEvidence,
    verified: resumeEvidence?.verified === true && resumeEvidence.cursorRegression !== true && !cycleCursorRegression,
    cursorRegression: resumeEvidence?.cursorRegression === true || cycleCursorRegression,
    cursorCount: cursors.length,
    cursorWatermarks: Object.fromEntries(cursors.map((cursor) => [cursor.poolAddress, { blockTime: cursor.oldestFetchedBlockTime, slot: cursor.oldestFetchedSlot }])),
    checkedAt: now.toISOString(),
  });
  const allEvents = readNormalizedSwaps(pools.map((pool) => pool.id), new Date(now.getTime() - RAW_BACKFILL_HOURS * 60 * 60_000));
  if (eventBatch.length > 0) persistNormalizedSwaps(eventBatch, PARSER_VERSION);
  const mergedEvents = [...new Map([...allEvents, ...eventBatch].map((event) => [`${event.signature}:${event.instructionIndex ?? 0}:${event.poolId}`, event])).values()];
  const buckets = materializeMinuteBuckets(targetDiscoveryPools, mergedEvents, cursors, now);
  persistMinuteBuckets(buckets);
  const httpMetrics = getHttpMetricsSnapshot();
  persistIndexerState("rpc.metrics", httpMetrics);
  persistIndexerState("rpc.metrics.backfill", httpMetrics);
  const pauseReason = throttle.status === "PAUSED" && cursors.some((cursor) => cursor.status !== "COMPLETE") ? throttle.reason : null;
  const nextJob = updateJob(job, cursors, targetBlockTime, now, httpMetrics, transactionSuccesses, repair.restartCount, repair.blocked, pauseReason);
  const windowProgress = progressForWindows(cursors, pools.length, now, nextJob);
  const assertion = validateWindowProgress(windowProgress);
  job = assertion.valid ? nextJob : { ...nextJob, status: "BACKFILL_PROGRESS_INVALID", blockedReason: assertion.reason };
  persistBackfillJob(job);
  persistIndexerState("backfill.raw_swaps_12h", job);
  persistIndexerState("backfill.diagnostics", { job, failures: readBackfillFailures(RAW_BACKFILL_JOB_ID, 50), storage: getStorageMetricsSnapshot(), rpc: httpMetrics, checkedAt: now.toISOString() });
  const coverage: Record<string, Record<"1h" | "6h" | "12h", EventWindowCoverage>> = Object.fromEntries(targetDiscoveryPools.map((pool) => [pool.id, coverageFromBuckets(pool, cursorMap.get(pool.id) as BackfillPoolCursor, buckets, now)]));
  if (pauseReason) {
    for (const pool of targetDiscoveryPools) {
      for (const window of SHORT_WINDOWS) {
        if (coverage[pool.id]?.[window].backfillStatus !== "COMPLETE") coverage[pool.id][window].progressReason = pauseReason;
      }
    }
  }
  persistWindowCoverage(coverage);
  persistIndexerState("backfill.parser_funnel", {
    generatedAt: now.toISOString(),
    parserVersion: PARSER_VERSION,
    targetPoolIds: pools.map((pool) => pool.id),
    windows: Object.fromEntries(pools.map((pool) => [pool.id, {
      all: readParserFunnel(pool.id),
      oneHour: readParserFunnel(pool.id, new Date(now.getTime() - 60 * 60_000)),
    }])),
  });
  persistIndexerState("backfill.window_status", {
    generatedAt: now.toISOString(),
    statuses: Object.fromEntries(targetDiscoveryPools.map((pool) => {
      const item = coverage[pool.id];
      const symbol = assetSymbol(pool);
      return [symbol, {
        [`${symbol}_1H_READY`]: item?.["1h"].backfillStatus === "COMPLETE" || item?.["1h"].backfillStatus === "LIVE",
        [`${symbol}_6H_COMPLETE`]: item?.["6h"].backfillStatus === "COMPLETE" || item?.["6h"].backfillStatus === "LIVE",
        [`${symbol}_12H_COMPLETE`]: item?.["12h"].backfillStatus === "COMPLETE" || item?.["12h"].backfillStatus === "LIVE",
        [`${symbol}_6H_BACKFILLING`]: item?.["6h"].backfillStatus === "BACKFILLING" || item?.["6h"].backfillStatus === "RUNNING",
        [`${symbol}_12H_BACKFILLING`]: item?.["12h"].backfillStatus === "BACKFILLING" || item?.["12h"].backfillStatus === "RUNNING",
        evidence: {
          oneHour: item?.["1h"],
          sixHour: item?.["6h"],
          twelveHour: item?.["12h"],
        },
      }];
    })),
  });
  return { discovery, provider, poolIds: pools.map((pool) => pool.id), cursors, events: mergedEvents, coverage, job };
}

export async function runBackfillWorker(): Promise<void> {
  const intervalMs = Math.max(30_000, Number(process.env.LP_BACKFILL_INTERVAL_MS ?? 60_000));
  const runForMs = Math.max(0, Number(process.env.LP_BACKFILL_RUN_FOR_MS ?? 0));
  const startedAt = Date.now();
  let stopped = false;
  const stop = () => { stopped = true; };
  const previousLifecycle = readIndexerState<{ status?: string; pid?: number }>("worker.lifecycle.backfill");
  const existingCursors = readBackfillPoolCursors(RAW_BACKFILL_JOB_ID);
  const previousResume = readIndexerState<{ cursorWatermarks?: Record<string, { blockTime: string | null; slot: number | null }> }>("backfill.resume");
  const cursorRegression = existingCursors.some((cursor) => {
    const previous = previousResume?.cursorWatermarks?.[cursor.poolAddress];
    if (!previous) return false;
    const currentTime = cursor.oldestFetchedBlockTime ? Date.parse(cursor.oldestFetchedBlockTime) : null;
    const previousTime = previous.blockTime ? Date.parse(previous.blockTime) : null;
    const movedNewerInTime = currentTime !== null && previousTime !== null && Number.isFinite(currentTime) && Number.isFinite(previousTime) && currentTime > previousTime;
    const movedNewerInSlot = cursor.oldestFetchedSlot !== null && previous.slot !== null && cursor.oldestFetchedSlot > previous.slot;
    return movedNewerInTime || movedNewerInSlot;
  });
  const resumedAfterRestart = previousLifecycle?.pid !== process.pid && existingCursors.length > 0;
  persistIndexerState("backfill.resume", {
    verified: resumedAfterRestart && !cursorRegression,
    resumedAfterRestart,
    cursorRegression,
    cursorCount: existingCursors.length,
    cursorWatermarks: Object.fromEntries(existingCursors.map((cursor) => [cursor.poolAddress, { blockTime: cursor.oldestFetchedBlockTime, slot: cursor.oldestFetchedSlot }])),
    checkedAt: new Date().toISOString(),
  });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  persistIndexerState("worker.lifecycle.backfill", { status: "RUNNING", startedAt: new Date(startedAt).toISOString(), pid: process.pid });
  try {
    while (!stopped && (runForMs === 0 || Date.now() - startedAt < runForMs)) {
      if (process.env.LP_DISABLE_BACKFILL === "1") {
        const job = readBackfillJob(RAW_BACKFILL_JOB_ID);
        if (job && job.status !== "LIVE") {
          persistBackfillJob({ ...job, status: "BLOCKED", blockedReason: "LP_DISABLE_BACKFILL=1", lastProgressAt: new Date().toISOString() });
        }
        persistIndexerState("backfill.blocked", { status: "BLOCKED", reason: "LP_DISABLE_BACKFILL=1", checkedAt: new Date().toISOString() });
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
