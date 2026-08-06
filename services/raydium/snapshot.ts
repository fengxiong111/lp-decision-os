import { CAPITAL_OPTIONS, WINDOW_KEYS, type DashboardSnapshot, type EventIndexSnapshot, type EventWindowCoverage, type GroundTruthCalibration, type IndexerStatusReport, type LastSwap, type OfficialReconciliationSnapshot, type PoolVerification, type PositionSnapshot, type ProductStatusReport, type PublicMarketHealth, type PublicMarketLevel, type PublicMetricsState, type QualitySnapshot, type RankingSummary, type RpcPoolSnapshot, type ServiceHealth, type SwapEventRecord, type WindowKey } from "@/packages/models/src";
import { aggregateQuality } from "@/services/quality";
import { getMarketSession } from "@/services/session";
import { buildPoolSnapshots, refreshExecutableModels } from "@/services/metrics";
import { refreshDecisionModels } from "@/services/decision";
import { buildCalibrationRegressionCases } from "@/services/raydium/calibration";
import { discoverRwaUsdcPools } from "@/services/raydium/api";
import { fetchPoolKeys, fetchTickLine, type TickLine } from "@/services/raydium/keys";
import {
  getActiveRpcProvider,
  getRpcPoolSnapshot,
  probeSolanaWebSocket,
  type RecentSwapEvent,
} from "@/services/rpc/pool";
import { reconcilePools } from "@/services/reconciler";
import { buildPositionSnapshots, discoverReadOnlyClmmPositions } from "@/services/raydium/positions";
import { getConfiguredReadOnlyAddress } from "@/services/wallet/config";
import { getLocalAccessInfo } from "@/services/network/access";
import { countPositionSnapshots, getEventStoreError, getScannedPoolIds, persistIndexerState, persistPositionSnapshots, readIndexerState, readLatestPositionSnapshot, readLatestPositionSnapshotsForOwner, readPositionBaseline, readRecentSwapEvents, readWindowCoverage, readOfficialReconciliation } from "@/services/storage/event-index";
import { selectTop20Pools, SHORT_WINDOW_POOL_LIMIT } from "@/services/indexer/universe";

let cachedSnapshot: { expiresAt: number; value: DashboardSnapshot } | null = null;
let latestSnapshot: DashboardSnapshot | null = null;

type SnapshotOptions = {
  apiOnly?: boolean;
};

function emptyRpcPoolSnapshot(): RpcPoolSnapshot {
  return {
    activeProvider: null,
    currentSlot: null,
    finalizedSlot: null,
    slotLag: null,
    providers: [],
  };
}

const statusFromApi = (status: DashboardSnapshot["raydiumApi"]["status"]): ServiceHealth["status"] => status;

function emptyQuality(): QualitySnapshot {
  return {
    score: null,
    status: "blocked",
    reasons: ["没有可用的链上复核结果"],
    metricScores: { TVL: null, 费用: null, 成交量: null, RPC: null, WebSocket: null },
    details: {},
    sources: [],
  };
}

function emptyAssetCoverage(candidateRwaAssetCount: number | null) {
  return {
    candidateRwaAssetCount,
    identityVerifiedAssetCount: 0,
    stockMappedAssetCount: null,
    etfMappedAssetCount: null,
    withUsdcPoolAssetCount: 0,
    currentlyTradableAssetCount: 0,
    with24hVolumeAssetCount: 0,
    withMinuteSwapAssetCount: 0,
    classificationSource: "Raydium API 未提供权威股票/ETF分类；分类不做猜测",
  };
}

function incompleteWindow(window: WindowKey, generatedAt: string): EventWindowCoverage {
  return {
    eventCount: 0,
    poolCount: 0,
    firstSlot: null,
    lastSlot: null,
    firstEventAt: null,
    lastEventAt: null,
    completeness: null,
    persisted: false,
    source: window === "24h" ? "Raydium v3 day + RPC 回补待对账" : "Solana RPC 交易回补待完成",
    windowStart: new Date(new Date(generatedAt).getTime() - ({ "1m": 60_000, "5m": 5 * 60_000, "30m": 30 * 60_000, "1h": 60 * 60_000, "6h": 6 * 60 * 60_000, "12h": 12 * 60 * 60_000, "24h": 24 * 60 * 60_000 }[window])).toISOString(),
    windowEnd: generatedAt,
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
    backfillStatus: "PARTIAL",
  };
}

function apiOnlyWindowCoverage(generatedAt: string): Record<WindowKey, EventWindowCoverage> {
  return Object.fromEntries(WINDOW_KEYS.map((window) => [window, {
    ...incompleteWindow(window, generatedAt),
    source: window === "24h" ? "Raydium API v3 官方24h 数据；无链上回补" : "Raydium API 不提供该分钟级窗口；等待 RPC / WebSocket",
    backfillStatus: "UNAVAILABLE" as const,
  }])) as Record<WindowKey, EventWindowCoverage>;
}

function unverifiedPool(slot: number | null): PoolVerification {
  return {
    poolAccountExists: false,
    poolOwner: null,
    programVerified: false,
    mintsVerified: false,
    vaultsVerified: false,
    active: false,
    verifiedAt: null,
    slot,
  };
}

function emptyCalibration(generatedAt: string): GroundTruthCalibration {
  const walletAddress = getConfiguredReadOnlyAddress();
  return {
    status: "BLOCKED",
    modelVersion: "ground-truth-calibration-v1",
    walletAddress,
    walletConfigured: Boolean(walletAddress),
    positionsDiscovered: 0,
    snapshotsPersisted: 0,
    feeReconciliationsPassed: 0,
    feeReconciliationsFailed: 0,
    windowCoveragePassed: false,
    rankingRegressionPassed: false,
    regressionCases: [],
    blockers: [
      ...(walletAddress ? [] : ["未配置 READ_ONLY_SOLANA_ADDRESS，无法读取真实 CLMM 仓位"]),
      "1h / 12h / 24h 逐交易覆盖率尚未达到 COMPLETE",
      "Swap LP Fee 与 fee_growth_global 双路线对账尚未完成",
      "执行成本、IL 与预测净收益尚未完成，禁止生成默认综合排名",
    ],
    lastCheckedAt: generatedAt,
  };
}

function defaultRanking(): RankingSummary {
  return {
    defaultMode: "executableFee",
    requestedDefaultMode: "executableNet",
    available: {
      executableNet: false,
      executableFee: false,
      lpFee: false,
      volume: false,
      lpFeeDensity: false,
      lpFee1h: false,
      lpFee6h: false,
      lpFee12h: false,
      officialFee24h: false,
      routeShare: false,
      acceleration: false,
      capitalUtilization: false,
      officialApr: false,
      officialVolume: false,
      officialFee: false,
      feeDensity: false,
      activity: false,
      predictedFee: false,
      actualPositionReturn: false,
      predictedNet: false,
      riskAdjustedNet: false,
    },
    blockers: [
      "官方 API 公开市场数据尚未加载",
      "可执行手续费需要完整窗口真实 LP Fee",
      "净收益模型尚未完成",
    ],
    modelVersion: "executable-capacity-v1",
    capitalOptions: [...CAPITAL_OPTIONS],
  };
}

function defaultIndexerStatus(input: { apiAvailable: boolean; websocket: ServiceHealth; hasRpc: boolean; detail?: string }): IndexerStatusReport {
  return {
    PUBLIC_MARKET_DATA: input.apiAvailable ? "READY" : "UNAVAILABLE",
    REALTIME_STREAM: input.websocket.status === "在线" ? "CONNECTED_WAITING_FOR_EVENTS" : input.websocket.status === "未配置" ? "NOT_CONFIGURED" : "UNAVAILABLE",
    HISTORICAL_BACKFILL_1H: "UNAVAILABLE",
    HISTORICAL_BACKFILL_6H: "UNAVAILABLE",
    HISTORICAL_BACKFILL_12H: "UNAVAILABLE",
    HISTORICAL_BACKFILL_24H: "UNAVAILABLE",
    FEE_PARSER: "UNAVAILABLE",
    ROUTE_SHARE: "UNAVAILABLE",
    OFFICIAL_RECONCILIATION: "UNAVAILABLE",
    NET_YIELD_MODEL: "NOT_IMPLEMENTED",
    WALLET_POSITIONS: getConfiguredReadOnlyAddress() && input.hasRpc ? "OPTIONAL_CONFIGURED" : "OPTIONAL_NOT_CONFIGURED",
    ...(input.detail ? {} : {}),
  };
}

function emptyOfficialReconciliation(detail: string): OfficialReconciliationSnapshot {
  return {
    status: "UNAVAILABLE",
    officialAsOf: null,
    localAsOf: null,
    poolCount: 0,
    comparedPoolCount: 0,
    volumeDifferencePct: null,
    feeDifferencePct: null,
    failedPoolCount: 0,
    lastRunAt: null,
    detail,
  };
}

function summarizeOfficialReconciliation(poolCount: number): OfficialReconciliationSnapshot {
  const rows = readOfficialReconciliation();
  if (rows.length === 0) return emptyOfficialReconciliation("尚未运行官方 24h 对账");
  const failedPoolCount = rows.filter((row) => row.status === "FAILED").length;
  const compared = rows.filter((row) => row.localVolume24h !== null || row.localFee24h !== null).length;
  const latest = rows.map((row) => row.checkedAt).sort().at(-1) ?? null;
  const avg = (values: Array<number | null>) => {
    const known = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    return known.length > 0 ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
  };
  const status: OfficialReconciliationSnapshot["status"] = failedPoolCount > 0 ? "FAILED" : compared === poolCount && rows.every((row) => row.status === "READY") ? "READY" : "PARTIAL";
  return {
    status,
    officialAsOf: rows.map((row) => row.officialAsOf).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null,
    localAsOf: rows.map((row) => row.localAsOf).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null,
    poolCount,
    comparedPoolCount: compared,
    volumeDifferencePct: avg(rows.map((row) => row.volumeDifferencePct)),
    feeDifferencePct: avg(rows.map((row) => row.feeDifferencePct)),
    failedPoolCount,
    lastRunAt: latest,
    detail: failedPoolCount > 0 ? `${failedPoolCount} 个 Pool 超过 1% 差异，已停止进入官方对账排名` : `${compared}/${poolCount} 个 Pool 已完成官方 24h 对账`,
  };
}

function websocketHealthFromWorker(generatedAt: string): ServiceHealth | null {
  const state = readIndexerState<{ status?: string; detail?: string; lastSlot?: number | null }>("stream.status");
  if (!state?.status) return null;
  const status: ServiceHealth["status"] = state.status === "CONNECTED" ? "在线" : state.status === "NOT_CONFIGURED" ? "未配置" : state.status === "RECONNECTING" || state.status === "CONNECTING" ? "降级" : "离线";
  return {
    name: "solana-ws",
    label: "Solana WebSocket Pool",
    status,
    latencyMs: null,
    detail: `${state.detail ?? "独立 stream worker"}${state.lastSlot ? ` · last slot ${state.lastSlot}` : ""}`,
    sourceUrl: null,
    checkedAt: generatedAt,
  };
}

function publicMarketHealth(input: {
  pools: number;
  pairs: number;
  assets: number | null;
  apiAvailable: boolean;
  apiStatus: DashboardSnapshot["raydiumApi"]["status"];
  apiLatencyMs: number | null;
  updatedAt: string | null;
  level: PublicMarketLevel;
  detail: string;
}): PublicMarketHealth {
  const status = !input.apiAvailable || input.pools === 0
    ? "PUBLIC_RWA_MARKET_UNAVAILABLE"
    : input.apiStatus === "在线"
      ? "PUBLIC_RWA_MARKET_READY"
      : "PUBLIC_RWA_MARKET_DEGRADED";
  return {
    mode: "PUBLIC_MARKET",
    status,
    level: input.level,
    label: input.level === "LEVEL_1_API"
      ? "官方 API 数据模式"
      : input.level === "LEVEL_2_RPC"
        ? "链上账户已核验"
        : "链上实时数据完整",
    detail: input.detail,
    apiAvailable: input.apiAvailable,
    assetCount: input.assets,
    pairCount: input.pairs,
    poolCount: input.pools,
    source: "Raydium API v3 / RWA list-v2",
    updatedAt: input.updatedAt,
    apiLatencyMs: input.apiLatencyMs,
  };
}

function statusReport(input: {
  publicMarket: PublicMarketHealth;
  rpc: DashboardSnapshot["rpc"];
  websocket: ServiceHealth;
  swapIndexer: EventIndexSnapshot;
  verifiedPoolCount: number;
  walletConfigured: boolean;
  netYieldAvailable: boolean;
  shortWindowReady: boolean;
}): ProductStatusReport {
  const rpcAvailable = input.rpc.activeProvider !== null;
  const rpcVerificationStatus = !rpcAvailable
    ? "RPC_VERIFICATION_UNAVAILABLE"
    : input.verifiedPoolCount === 0
      ? "RPC_VERIFICATION_DEGRADED"
      : input.publicMarket.level === "LEVEL_2_RPC"
        ? "RPC_VERIFICATION_PARTIAL"
        : "RPC_VERIFICATION_AVAILABLE";
  return {
    PUBLIC_MARKET_STATUS: input.publicMarket.status === "PUBLIC_RWA_MARKET_READY" ? "PUBLIC_API_MARKET_READY" : input.publicMarket.status,
    SHORT_WINDOW_ANALYTICS_STATUS: input.shortWindowReady ? "SHORT_WINDOW_ANALYTICS_READY" : "SHORT_WINDOW_ANALYTICS_UNAVAILABLE",
    RPC_VERIFICATION_STATUS: rpcVerificationStatus,
    REALTIME_INDEXING_STATUS: input.swapIndexer.status === "在线" && input.websocket.status === "在线" ? "REALTIME_INDEXING_AVAILABLE" : "REALTIME_INDEXING_DEGRADED",
    WALLET_POSITION_STATUS: input.walletConfigured ? "WALLET_POSITION_OPTIONAL_CONFIGURED" : "WALLET_POSITION_OPTIONAL_NOT_CONFIGURED",
    NET_YIELD_STATUS: input.netYieldAvailable ? "NET_YIELD_AVAILABLE" : "NET_YIELD_UNAVAILABLE",
  };
}

function enrichPositionMetrics(positions: PositionSnapshot[]): PositionSnapshot[] {
  return positions.map((position) => {
    const baseline = readPositionBaseline(position.positionNftMint);
    const previous = readLatestPositionSnapshot(position.positionNftMint);
    const elapsed = previous ? Math.max(0, Date.parse(position.observedAt) - Date.parse(previous.observedAt)) / 1000 : 0;
    const activeSeconds = (previous?.activeSeconds ?? 0) + (previous?.inRange === true ? elapsed : 0);
    const holdBenchmarkValue = baseline?.holdBenchmarkValue ?? baseline?.positionValueUsd ?? position.positionValueUsd;
    const feeDelta = baseline?.uncollectedFeeUsd !== null && baseline?.uncollectedFeeUsd !== undefined && position.uncollectedFeeUsd !== null
      ? position.uncollectedFeeUsd - baseline.uncollectedFeeUsd
      : null;
    const actualFeeReturn = feeDelta !== null && baseline?.positionValueUsd && baseline.positionValueUsd > 0 ? feeDelta / baseline.positionValueUsd : null;
    const inRangeHourlyFeeRate = actualFeeReturn !== null && activeSeconds > 0 ? actualFeeReturn / (activeSeconds / 3600) : null;
    return {
      ...position,
      activeSeconds: Math.round(activeSeconds),
      holdBenchmarkValue,
      actualFeeReturn,
      realizedFeeReturn: actualFeeReturn,
      inRangeHourlyFeeRate,
      // Relative hold net return deliberately remains null until execution cost and IL are measured.
      relativeHoldNetReturn: null,
    } satisfies PositionSnapshot;
  });
}

function emptyEventIndex(generatedAt: string, websocket: ServiceHealth, totalPoolCount = 0): EventIndexSnapshot {
  const windows = Object.fromEntries(WINDOW_KEYS.map((window) => [window, incompleteWindow(window, generatedAt)])) as Record<WindowKey, EventWindowCoverage>;
  return {
    status: websocket.status === "在线" ? "降级" : websocket.status,
    label: "Swap 解析",
    detail: websocket.status === "在线" ? "WebSocket 已订阅 Raydium 日志，等待可验证 Swap" : "等待 WebSocket 与 RPC",
    sourceUrl: websocket.sourceUrl,
    checkedAt: generatedAt,
    eventCount: 0,
    poolCount: 0,
    liveEventCount: 0,
    persistedEventCount: 0,
    parseLatencyMs: null,
    persistenceLatencyMs: null,
    backfillProgress: totalPoolCount === 0 ? null : 0,
    scannedPoolCount: 0,
    totalPoolCount,
    windows,
    poolCoverage: {},
    apiAsOfTime: null,
    apiAgeSeconds: null,
    crossChecks: {
      fiveMinuteToHour: { expectedBuckets: 12, observedBuckets: 0, matches: null, detail: "等待完整 5 分钟交易桶" },
      hourToTwelveHour: { expectedBuckets: 12, observedBuckets: 0, matches: null, detail: "等待完整 1 小时交易桶" },
    },
  };
}

function eventWindowFor(blockTime: string | null, now: string): WindowKey | null {
  if (!blockTime) return null;
  const age = new Date(now).getTime() - new Date(blockTime).getTime();
  if (age < 0) return null;
  if (age <= 60_000) return "1m";
  if (age <= 5 * 60_000) return "5m";
  if (age <= 30 * 60_000) return "30m";
  if (age <= 60 * 60_000) return "1h";
  if (age <= 6 * 60 * 60_000) return "6h";
  if (age <= 12 * 60 * 60_000) return "12h";
  if (age <= 24 * 60 * 60_000) return "24h";
  return null;
}

function lastSwapFromEvent(event: SwapEventRecord, generatedAt: string, sourceUrl: string): LastSwap {
  return {
    signature: event.signature,
    poolId: event.poolId,
    slot: event.slot,
    blockTime: event.blockTime,
    sourceUrl,
    parsedAt: event.parsedAt,
    parseLatencyMs: event.parseLatencyMs,
    persistenceLatencyMs: event.persistenceLatencyMs,
    persisted: Boolean(event.persistedAt),
    eventWindow: eventWindowFor(event.blockTime, generatedAt),
  };
}

function buildEventIndex(
  events: SwapEventRecord[],
  liveEvents: SwapEventRecord[],
  generatedAt: string,
  websocket: ServiceHealth,
  scannedPoolCount: number,
  totalPoolCount: number,
  persistenceLatencyMs: number | null,
  storeError: string | null,
  collectionError: string | null,
  apiAsOfTime: string | null,
  apiAgeSeconds: number | null,
  poolCoverage: Record<string, Record<WindowKey, EventWindowCoverage>>,
): EventIndexSnapshot {
  const secondsByWindow: Record<WindowKey, number> = { "1m": 60, "5m": 5 * 60, "30m": 30 * 60, "1h": 60 * 60, "6h": 6 * 60 * 60, "12h": 12 * 60 * 60, "24h": 24 * 60 * 60 };
  const nowMs = new Date(generatedAt).getTime();
  const windows = Object.fromEntries(WINDOW_KEYS.map((window) => {
    const selected = events.filter((event) => {
      const age = nowMs - new Date(event.blockTime).getTime();
      return age >= 0 && age <= secondsByWindow[window] * 1000;
    });
    const bySlot = [...selected].sort((a, b) => a.slot - b.slot);
    const base = incompleteWindow(window, generatedAt);
    return [window, {
      ...base,
      eventCount: selected.length,
      poolCount: new Set(selected.map((event) => event.poolId)).size,
      firstSlot: bySlot[0]?.slot ?? null,
      lastSlot: bySlot.at(-1)?.slot ?? null,
      firstEventAt: bySlot[0]?.blockTime ?? null,
      lastEventAt: bySlot.at(-1)?.blockTime ?? null,
      persisted: window === "24h" ? false : selected.length > 0 && selected.every((event) => Boolean(event.persistedAt)),
      signaturesDiscovered: selected.length,
      transactionsFetched: selected.length,
      transactionsSuccessful: selected.length,
      swapsParsed: selected.length,
      firstEventTime: bySlot[0]?.blockTime ?? null,
      lastEventTime: bySlot.at(-1)?.blockTime ?? null,
      source: window === "24h" ? "Raydium v3 day + SQLite 对账待完成" : "Solana RPC Swap 事件 → SQLite（仅已观察事件）",
    } satisfies EventWindowCoverage];
  })) as Record<WindowKey, EventWindowCoverage>;
  for (const window of WINDOW_KEYS) {
    const rows = Object.values(poolCoverage).map((item) => item[window]).filter((item): item is EventWindowCoverage => Boolean(item));
    const allComplete = rows.length === totalPoolCount && totalPoolCount > 0 && rows.every((item) => (item.backfillStatus === "COMPLETE" || item.backfillStatus === "LIVE") && item.coverageRatio === 100 && item.gapSlots === 0 && item.unknownInstructions === 0);
    const allKnown = rows.length === totalPoolCount && rows.every((item) => item.unknownInstructions !== null && item.gapSlots !== null);
    const sum = (field: keyof EventWindowCoverage) => rows.reduce((total, item) => total + (typeof item[field] === "number" ? item[field] as number : 0), 0);
    const firstSlots = rows.flatMap((item) => item.firstSlot === null ? [] : [item.firstSlot]);
    const lastSlots = rows.flatMap((item) => item.lastSlot === null ? [] : [item.lastSlot]);
    windows[window] = {
      ...windows[window],
      signaturesDiscovered: sum("signaturesDiscovered"),
      transactionsFetched: sum("transactionsFetched"),
      transactionsSuccessful: sum("transactionsSuccessful"),
      transactionsFailed: sum("transactionsFailed"),
      swapsParsed: sum("swapsParsed"),
      swapsRejected: sum("swapsRejected"),
      duplicatesRemoved: sum("duplicatesRemoved"),
      unknownInstructions: allKnown ? sum("unknownInstructions") : null,
      gapSlots: allKnown ? sum("gapSlots") : null,
      coverageRatio: allComplete ? 100 : null,
      backfillStatus: allComplete ? (rows.some((item) => item.backfillStatus === "LIVE") ? "LIVE" : "COMPLETE") : rows.some((item) => item.backfillStatus === "RUNNING" || item.backfillStatus === "BACKFILLING") ? "BACKFILLING" : rows.length === 0 ? "UNAVAILABLE" : "PARTIAL",
      startSlot: firstSlots.length > 0 ? Math.min(...firstSlots) : null,
      endSlot: lastSlots.length > 0 ? Math.max(...lastSlots) : null,
      expectedSlotRange: firstSlots.length > 0 && lastSlots.length > 0 ? { start: Math.min(...firstSlots), end: Math.max(...lastSlots) } : null,
      targetPoolCount: totalPoolCount,
      completedPoolCount: rows.filter((item) => (item.backfillStatus === "COMPLETE" || item.backfillStatus === "LIVE") && item.coverageRatio === 100 && item.gapSlots === 0 && item.unknownInstructions === 0).length,
    };
  }
  const backfillProgress = totalPoolCount > 0 ? Math.min(100, (scannedPoolCount / totalPoolCount) * 100) : null;
  const persisted = events.filter((event) => Boolean(event.persistedAt));
  const latest = [...events].sort((a, b) => b.slot - a.slot)[0] ?? null;
  const status = storeError || collectionError ? "降级" : persisted.length > 0 ? "在线" : websocket.status === "在线" ? "降级" : "离线";
  return {
    status,
    label: "Swap 解析",
    detail: storeError
      ? `SQLite 错误：${storeError}`
      : collectionError
        ? `RPC 回补错误：${collectionError}`
      : persisted.length > 0
        ? `已解析 ${events.length} 笔 · 已落库 ${persisted.length} 笔 · 最近 Slot ${latest?.slot ?? "等待事件"}`
        : websocket.status === "在线" ? "WebSocket 已订阅，RPC 回补暂未找到 Swap" : "等待 WebSocket 与 RPC",
    sourceUrl: latest ? "https://api.mainnet-beta.solana.com" : websocket.sourceUrl,
    checkedAt: generatedAt,
    eventCount: events.length,
    poolCount: new Set(events.map((event) => event.poolId)).size,
    liveEventCount: liveEvents.length,
    persistedEventCount: persisted.length,
    parseLatencyMs: events.length > 0 ? Math.round(events.reduce((total, event) => total + (event.parseLatencyMs ?? 0), 0) / events.length) : null,
    persistenceLatencyMs,
    backfillProgress,
    scannedPoolCount,
    totalPoolCount,
    windows,
    poolCoverage,
    apiAsOfTime,
    apiAgeSeconds,
    crossChecks: {
      fiveMinuteToHour: { expectedBuckets: 12, observedBuckets: 0, matches: null, detail: "交易历史未完成逐桶回补，暂不交叉校验" },
      hourToTwelveHour: { expectedBuckets: 12, observedBuckets: 0, matches: null, detail: "交易历史未完成逐桶回补，暂不交叉校验" },
    },
  };
}

function overlayPersistedWindowProgress(indexer: EventIndexSnapshot, persisted: PublicMetricsState | null): EventIndexSnapshot {
  if (!persisted) return indexer;
  const windows = { ...indexer.windows };
  // 24h 公开窗口继续以 Raydium API 为参考；worker 只覆盖链上分钟/短窗口。
  for (const window of WINDOW_KEYS.filter((item) => item !== "24h")) {
    const saved = persisted.windows[window];
    if (!saved) continue;
    const hasProgress = saved.coverageRatio !== null
      || saved.completeness !== null
      || saved.signaturesDiscovered > 0
      || saved.transactionsFetched > 0
      || saved.backfillStatus !== "PARTIAL";
    if (!hasProgress) continue;
    windows[window] = {
      ...windows[window],
      ...saved,
      source: saved.source || windows[window].source,
    };
  }
  return { ...indexer, windows };
}

function hasLegacyFullUniverseProgress(snapshot: DashboardSnapshot | null): boolean {
  if (!snapshot?.swapIndexer) return false;
  const targetPoolCounts = Object.values(snapshot.swapIndexer.windows)
    .map((window) => window.targetPoolCount ?? null)
    .filter((value): value is number => value !== null);
  return (snapshot.swapIndexer.totalPoolCount ?? 0) > SHORT_WINDOW_POOL_LIMIT
    || targetPoolCounts.some((value) => value > SHORT_WINDOW_POOL_LIMIT);
}

function buildEmptySnapshot(input: {
  generatedAt: string;
  apiStatus: DashboardSnapshot["raydiumApi"]["status"];
  apiLatencyMs: number | null;
  apiErrors: string[];
  rwaAssetCount: number | null;
  candidatePoolCount: number;
  pairCount: number;
  rpc: DashboardSnapshot["rpc"];
  websocket: ServiceHealth;
  apiUrl: string;
  officialPageUrl: string;
}): DashboardSnapshot {
  const session = getMarketSession();
  const swapIndexer = emptyEventIndex(input.generatedAt, input.websocket, input.candidatePoolCount);
  const publicMarket = publicMarketHealth({
    pools: 0,
    pairs: input.pairCount,
    assets: input.rwaAssetCount,
    apiAvailable: false,
    apiStatus: input.apiStatus,
    apiLatencyMs: input.apiLatencyMs,
    updatedAt: input.generatedAt,
    level: "LEVEL_1_API",
    detail: input.apiErrors[0] ?? "Raydium API 未返回可展示的 RWA/USDC Pool",
  });
  const raydiumApi: ServiceHealth = {
    name: "raydium-api",
    label: "Raydium v3 API",
    status: statusFromApi(input.apiStatus),
    latencyMs: input.apiLatencyMs,
    detail: input.apiErrors[0] ?? "等待 RWA 数据",
    sourceUrl: input.apiUrl,
    checkedAt: input.generatedAt,
  };
  const indexerStatus = defaultIndexerStatus({ apiAvailable: false, websocket: input.websocket, hasRpc: input.rpc.activeProvider !== null, detail: input.apiErrors[0] });
  return {
    status: "LIVE_RWA_DATA_PARTIAL",
    generatedAt: input.generatedAt,
    network: "Solana Mainnet",
    pools: [],
    pairs: [],
    discovery: {
      rwaAssetCount: input.rwaAssetCount,
      candidatePoolCount: input.candidatePoolCount,
      pairCount: input.pairCount,
      verifiedPoolCount: 0,
      apiStatus: input.apiStatus,
      apiUrl: input.apiUrl,
      officialPageUrl: input.officialPageUrl,
      discoveredAt: input.generatedAt,
      apiObservedAt: null,
      errors: input.apiErrors,
      assetCoverage: emptyAssetCoverage(input.rwaAssetCount),
    },
    session,
    rpc: input.rpc,
    websocket: input.websocket,
    raydiumApi,
    swapIndexer,
    dataQuality: emptyQuality(),
    lastSwap: null,
    positions: [],
    calibration: emptyCalibration(input.generatedAt),
    ranking: defaultRanking(),
    publicMarket,
    statusReport: statusReport({ publicMarket, rpc: input.rpc, websocket: input.websocket, swapIndexer, verifiedPoolCount: 0, walletConfigured: Boolean(getConfiguredReadOnlyAddress()), netYieldAvailable: false, shortWindowReady: false }),
    indexerStatus,
    officialReconciliation: emptyOfficialReconciliation(input.apiErrors[0] ?? "公开 API 数据不可用"),
    wallet: { configured: Boolean(getConfiguredReadOnlyAddress()), address: getConfiguredReadOnlyAddress(), readOnly: true },
    alerts: input.apiErrors,
    snapshotSource: "LIVE",
    lastKnownGoodAt: null,
    localAccess: getLocalAccessInfo(),
  };
}

export async function collectDashboardSnapshot(force = false, options: SnapshotOptions = {}): Promise<DashboardSnapshot> {
  if (!force && cachedSnapshot && cachedSnapshot.expiresAt > Date.now()) return cachedSnapshot.value;
  const apiOnly = options.apiOnly === true;
  const generatedAt = new Date().toISOString();
  const workerWebsocket = websocketHealthFromWorker(generatedAt);
  const [discovery, rpc, websocket] = await Promise.all([
    discoverRwaUsdcPools(),
    apiOnly ? Promise.resolve(emptyRpcPoolSnapshot()) : getRpcPoolSnapshot(),
    apiOnly
      ? Promise.resolve(workerWebsocket ?? {
          name: "solana-ws",
          label: "Solana WebSocket Pool",
          status: "降级" as const,
          latencyMs: null,
          detail: "页面只读取独立 Worker 状态",
          sourceUrl: null,
          checkedAt: generatedAt,
        })
      : workerWebsocket ? Promise.resolve(workerWebsocket) : probeSolanaWebSocket(),
  ]);
  const apiUrl = "https://api-v3.raydium.io";

  if (discovery.pools.length === 0) {
    const empty = buildEmptySnapshot({
      generatedAt,
      apiStatus: discovery.apiStatus,
      apiLatencyMs: discovery.apiLatencyMs,
      apiErrors: discovery.errors,
      rwaAssetCount: discovery.rwaAssetCount,
      candidatePoolCount: discovery.candidatePoolCount,
      pairCount: discovery.pairCount,
      rpc,
      websocket,
      apiUrl,
      officialPageUrl: "https://raydium.io/liquidity-pools/?type=RWA",
    });
    cachedSnapshot = { expiresAt: Date.now() + 20_000, value: empty };
    latestSnapshot = empty;
    return empty;
  }

  const provider = apiOnly ? null : getActiveRpcProvider(rpc);
  const keyResult = provider
    ? await fetchPoolKeys(discovery.pools.map((pool) => pool.id))
    : {
        keys: new Map(),
        source: { label: "Raydium Pool Keys", url: "https://api-v3.raydium.io/pools/key/ids", observedAt: generatedAt, status: "unavailable" as const },
        error: "RPC 不可用，Pool Keys 暂不核验",
      };
  const reconciliation = provider
    ? await reconcilePools({ provider, pools: discovery.pools, keys: keyResult.keys, slot: rpc.currentSlot })
    : { verification: new Map<string, PoolVerification>(), error: "RPC 不可用，公开 API 数据仍可用" };
  const verifiedPools = discovery.pools.filter((pool) => {
    const verification = reconciliation.verification.get(pool.id);
    return Boolean(verification?.active && verification.programVerified && verification.mintsVerified && verification.vaultsVerified);
  });
  const topForEvidence = [...verifiedPools].sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0)).slice(0, 16);
  const scanSince = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const persistedMetrics = readIndexerState<PublicMetricsState>("metrics.public");
  const [tickResults] = provider && verifiedPools.length > 0
    ? await Promise.all([
        Promise.all(topForEvidence.map(async (pool) => ({ id: pool.id, result: await fetchTickLine(pool.id) }))),
      ])
    : [[]];
  const indexedEvents = readRecentSwapEvents(
    discovery.pools.map((pool) => pool.id),
    new Date(Date.now() - 24 * 60 * 60 * 1000),
  );
  const swapEvents = indexedEvents;
  const liveSwapEvents: SwapEventRecord[] = [];
  const latestIndexedEvent = [...swapEvents].sort((a, b) => b.slot - a.slot)[0] ?? null;
  const lastSwap = latestIndexedEvent ? lastSwapFromEvent(latestIndexedEvent, generatedAt, provider?.url ?? "https://api.mainnet-beta.solana.com") : null;
  const scannedPoolIds = getScannedPoolIds(scanSince);
  const shortWindowPools = selectTop20Pools(discovery.pools);
  const shortWindowPoolIds = new Set(shortWindowPools.map((pool) => pool.id));
  const scannedPoolCount = [...scannedPoolIds].filter((poolId) => shortWindowPoolIds.has(poolId)).length;
  const storeError = getEventStoreError();
  const apiObservedAt = discovery.sources.find((source) => source.label === "Raydium RWA 池发现")?.observedAt ?? generatedAt;
  const apiAgeSeconds = Math.max(0, Math.round((new Date(generatedAt).getTime() - new Date(apiObservedAt).getTime()) / 1000));
  const storedPoolCoverage = readWindowCoverage(discovery.pools.map((pool) => pool.id));
  // Public discovery remains all-pool. Short-window evidence is deliberately
  // bounded to Top20 so an old 176-pool cursor cannot keep the product in a
  // false "waiting for every pool" state.
  const poolCoverage = Object.fromEntries(shortWindowPools.map((pool) => [pool.id, storedPoolCoverage[pool.id] ?? apiOnlyWindowCoverage(generatedAt)]));
  const persistedShortWindowTarget = Object.values(persistedMetrics?.windows ?? {})
    .map((window) => window.targetPoolCount ?? null)
    .filter((value): value is number => value !== null)
    .sort((left, right) => right - left)[0] ?? null;
  const legacyFullUniverseProgress = persistedShortWindowTarget !== null && persistedShortWindowTarget > shortWindowPools.length;
  const swapIndexer = overlayPersistedWindowProgress(
    buildEventIndex(swapEvents, liveSwapEvents, generatedAt, websocket, scannedPoolCount, shortWindowPools.length, null, storeError, persistedMetrics && !legacyFullUniverseProgress ? null : "等待 Top20 短窗口回补", apiObservedAt, apiAgeSeconds, poolCoverage),
    legacyFullUniverseProgress ? null : persistedMetrics,
  );
  const official24h = swapIndexer.windows["24h"];
  swapIndexer.windows["24h"] = {
    ...official24h,
    eventCount: 0,
    poolCount: discovery.pools.filter((pool) => pool.day.volume !== null || pool.day.volumeFee !== null || pool.day.apr !== null).length,
    completeness: 100,
    persisted: false,
    source: "Raydium v3 官方 24h API · as_of",
    windowStart: new Date(new Date(generatedAt).getTime() - 24 * 60 * 60_000).toISOString(),
    windowEnd: generatedAt,
    coverageRatio: 100,
    unknownInstructions: 0,
    gapSlots: 0,
    backfillStatus: "COMPLETE",
  };
  const session = getMarketSession(new Date(), lastSwap);
  const tickLines = new Map<string, TickLine[]>();
  for (const item of tickResults) {
    tickLines.set(item.id, item.result.line);
  }
  const eventsByPool = new Map<string, RecentSwapEvent[]>();
  for (const event of swapEvents) {
    const events = eventsByPool.get(event.poolId) ?? [];
    events.push(event);
    eventsByPool.set(event.poolId, events);
  }
  const sourceList = [...discovery.sources, keyResult.source];
  const completeShortHistoricalWindows = ["1h", "6h", "12h"].every((window) => {
    const coverage = swapIndexer.windows[window as WindowKey];
    return (coverage.backfillStatus === "COMPLETE" || coverage.backfillStatus === "LIVE") && coverage.coverageRatio === 100 && coverage.gapSlots === 0 && coverage.unknownInstructions === 0;
  });
  const completeHistoricalWindows = completeShortHistoricalWindows && discovery.pools.length > 0 && discovery.pools.every((pool) => pool.day.volume !== null || pool.day.volumeFee !== null || pool.day.apr !== null);
  const marketLevel: PublicMarketLevel = verifiedPools.length === 0
    ? "LEVEL_1_API"
    : websocket.status === "在线" && swapIndexer.status === "在线" && completeHistoricalWindows
      ? "LEVEL_3_REALTIME"
      : "LEVEL_2_RPC";
  const baseSnapshots = buildPoolSnapshots(
    discovery.pools.map((pool) => ({
      pool,
      keys: keyResult.keys.get(pool.id) ?? null,
      ticks: tickLines.get(pool.id) ?? [],
      swapEvents: eventsByPool.get(pool.id) ?? [],
      verification: reconciliation.verification.get(pool.id) ?? unverifiedPool(rpc.currentSlot),
      sources: sourceList,
      tickSource: tickResults.find((item) => item.id === pool.id)?.result.source ?? null,
      websocket,
      session,
      apiAgeSeconds,
      rpcSlotLag: rpc.slotLag,
      scannedForEvents: scannedPoolIds.has(pool.id),
      windowCoverage: poolCoverage[pool.id] ?? apiOnlyWindowCoverage(generatedAt),
      publicApiAvailable: true,
      marketLevel: verifiedPools.some((item) => item.id === pool.id) ? marketLevel : "LEVEL_1_API",
    })),
    generatedAt,
  );
  const workerMetrics = persistedMetrics && Date.parse(persistedMetrics.generatedAt) >= Date.now() - 15 * 60_000 ? persistedMetrics : null;
  let snapshots = refreshDecisionModels(baseSnapshots.map((pool) => {
    const state = workerMetrics?.pools[pool.id];
    if (!state) return refreshExecutableModels({ ...pool, recentSwaps: eventsByPool.get(pool.id)?.slice(0, 20) ?? [] });
    return refreshExecutableModels({
      ...pool,
      windows: { ...state.windows, "24h": pool.windows["24h"] },
      routeShareByWindow: { ...state.routeShareByWindow, "24h": pool.routeShareByWindow["24h"] },
      feeDensity: state.feeDensity ?? pool.feeDensity,
      velocity: state.velocity ?? pool.velocity,
      effectiveActiveTvl: state.effectiveActiveTvl ?? pool.effectiveActiveTvl,
      recentSwaps: state.recentSwaps,
    });
  }));
  const dataQuality = aggregateQuality(snapshots.map((pool) => pool.quality));
  const raydiumApi: ServiceHealth = {
    name: "raydium-api",
    label: "Raydium v3 API",
    status: statusFromApi(discovery.apiStatus),
    latencyMs: discovery.apiLatencyMs,
    detail: `RWA 资产 ${discovery.rwaAssetCount ?? "等待 API 统计"} · 公开池 ${snapshots.length} · 账户已核验 ${verifiedPools.length}`,
    sourceUrl: apiUrl,
    checkedAt: generatedAt,
  };
  const identityVerifiedAssets = new Set(snapshots.filter((pool) => pool.verificationStatus === "已核验").map((pool) => pool.asset.mint));
  const publicAssets = new Set(snapshots.map((pool) => pool.asset.mint));
  const assetsWith24hVolume = new Set(snapshots.filter((pool) => pool.volume24h !== null && pool.volume24h > 0).map((pool) => pool.asset.mint));
  const assetsWithMinuteSwap = new Set(snapshots.filter((pool) => (eventsByPool.get(pool.id)?.length ?? 0) > 0).map((pool) => pool.asset.mint));
  const assetCoverage = {
    candidateRwaAssetCount: discovery.rwaAssetCount,
    identityVerifiedAssetCount: identityVerifiedAssets.size,
    stockMappedAssetCount: null,
    etfMappedAssetCount: null,
    withUsdcPoolAssetCount: publicAssets.size,
    currentlyTradableAssetCount: new Set(snapshots.filter((pool) => pool.volume24h !== null || pool.tvl !== null).map((pool) => pool.asset.mint)).size,
    with24hVolumeAssetCount: assetsWith24hVolume.size,
    withMinuteSwapAssetCount: assetsWithMinuteSwap.size,
    classificationSource: "Raydium API 未提供权威股票/ETF分类；分类不做猜测",
  };
  const walletAddress = getConfiguredReadOnlyAddress();
  const shouldScanWallet = !apiOnly && force && Boolean(walletAddress) && Boolean(provider);
  const storedWalletPositions = walletAddress ? readLatestPositionSnapshotsForOwner(walletAddress) : [];
  const positionDiscovery = shouldScanWallet
    ? provider
      ? await discoverReadOnlyClmmPositions(provider, walletAddress)
      : { positions: [], errors: ["钱包已配置，但没有可用 RPC"], observedAt: generatedAt }
    : { positions: [], errors: walletAddress ? (storedWalletPositions.length > 0 ? [] : ["已配置只读钱包，尚未完成扫描；点击重新扫描"]) : ["未配置 READ_ONLY_SOLANA_ADDRESS（公开市场不受影响）"], observedAt: generatedAt };
  const positions = shouldScanWallet
    ? enrichPositionMetrics(buildPositionSnapshots(positionDiscovery.positions, snapshots, walletAddress ?? "未配置", generatedAt))
    : storedWalletPositions;
  snapshots = refreshDecisionModels(snapshots, positions);
  const regressionCases = buildCalibrationRegressionCases(snapshots, positions);
  const positionStore = shouldScanWallet ? persistPositionSnapshots(positions) : { persisted: 0, skipped: 0, error: null };
  const calibrationBase = emptyCalibration(generatedAt);
  const calibration: GroundTruthCalibration = {
    ...calibrationBase,
    status: "BLOCKED",
    walletAddress,
    walletConfigured: Boolean(walletAddress),
    positionsDiscovered: positions.length,
    snapshotsPersisted: countPositionSnapshots(),
    regressionCases,
    blockers: [
      ...calibrationBase.blockers.filter((blocker) => walletAddress || !blocker.startsWith("未配置 READ_ONLY_SOLANA_ADDRESS")),
      ...positionDiscovery.errors,
      ...(positionStore.error ? [`仓位快照存储失败：${positionStore.error}`] : []),
    ],
  };
  const publicMarket = publicMarketHealth({
    pools: snapshots.length,
    pairs: discovery.pairCount,
    assets: discovery.rwaAssetCount,
    apiAvailable: snapshots.length > 0,
    apiStatus: discovery.apiStatus,
    apiLatencyMs: discovery.apiLatencyMs,
    updatedAt: apiObservedAt,
    level: marketLevel,
    detail: verifiedPools.length > 0
      ? `官方 API ${snapshots.length} 个池；RPC 已核验 ${verifiedPools.length} 个；钱包配置不影响公开市场`
      : rpc.activeProvider
        ? `官方 API ${snapshots.length} 个池；RPC 账户核验尚未完成，分钟级链上指标降级`
        : `官方 API ${snapshots.length} 个池；RPC 当前不可用，分钟级链上指标降级`,
  });
  const ranking: RankingSummary = {
    defaultMode: snapshots.some((pool) => pool.executableEstimates["1000"]?.["1h"]?.netProfitUsd !== null) ? "executableNet" : "executableFee",
    requestedDefaultMode: "executableNet",
    available: {
      executableNet: snapshots.some((pool) => pool.executableEstimates["1000"]?.["1h"]?.netProfitUsd !== null),
      executableFee: snapshots.some((pool) => pool.executableEstimates["1000"]?.["1h"]?.expectedLpFeeUsd !== null),
      lpFee: snapshots.some((pool) => pool.windows["1h"].lpFeeUsd !== null),
      volume: snapshots.some((pool) => pool.windows["1h"].volume !== null),
      lpFeeDensity: snapshots.some((pool) => pool.windows["1h"].feeDensity !== null),
      lpFee1h: snapshots.some((pool) => pool.windows["1h"].lpFeeUsd !== null),
      lpFee6h: snapshots.some((pool) => pool.windows["6h"].lpFeeUsd !== null),
      lpFee12h: snapshots.some((pool) => pool.windows["12h"].lpFeeUsd !== null),
      officialFee24h: snapshots.some((pool) => pool.fee24h !== null),
      routeShare: snapshots.some((pool) => pool.routeShareByWindow["1h"].share !== null),
      acceleration: snapshots.some((pool) => pool.windows["1h"].liquidityVelocity !== null),
      capitalUtilization: snapshots.some((pool) => pool.windows["1h"].activeTvl !== null),
      officialApr: snapshots.some((pool) => pool.apr !== null || pool.feeApr !== null),
      officialVolume: snapshots.some((pool) => pool.volume24h !== null),
      officialFee: snapshots.some((pool) => pool.fee24h !== null),
      feeDensity: snapshots.some((pool) => pool.feeDensity !== null),
      activity: snapshots.some((pool) => pool.velocity !== null),
      predictedFee: snapshots.some((pool) => pool.predictedFee24h !== null),
      predictedNet: false,
      actualPositionReturn: positions.some((position) => position.actualFeeReturn !== null),
      riskAdjustedNet: false,
    },
    blockers: [
      ...(snapshots.some((pool) => pool.executableEstimates["1000"]?.["1h"]?.expectedLpFeeUsd !== null) ? [] : ["完整 1h 窗口与逐笔真实 LP Fee 尚未完成"]),
      "建仓滑点、交易费、优先费、退出成本、再平衡成本和 IL 模型尚未完成",
      ...(positions.length === 0 ? ["实际仓位收益仅在配置只读钱包后启用"] : []),
    ],
    modelVersion: "executable-capacity-v1",
    capitalOptions: [...CAPITAL_OPTIONS],
  };
  const report = statusReport({ publicMarket, rpc, websocket, swapIndexer, verifiedPoolCount: verifiedPools.length, walletConfigured: Boolean(walletAddress), netYieldAvailable: ranking.available.executableNet, shortWindowReady: completeShortHistoricalWindows && ranking.available.lpFee });
  const persistedIndexerStatus = readIndexerState<IndexerStatusReport>("indexer.status");
  const indexerStatus = persistedIndexerStatus ?? {
    ...defaultIndexerStatus({ apiAvailable: true, websocket, hasRpc: rpc.activeProvider !== null }),
    PUBLIC_MARKET_DATA: "READY",
    REALTIME_STREAM: websocket.status === "在线" ? "CONNECTED_WAITING_FOR_EVENTS" : "DEGRADED",
    HISTORICAL_BACKFILL_1H: swapIndexer.windows["1h"].backfillStatus,
    HISTORICAL_BACKFILL_6H: swapIndexer.windows["6h"].backfillStatus,
    HISTORICAL_BACKFILL_12H: swapIndexer.windows["12h"].backfillStatus,
    HISTORICAL_BACKFILL_24H: "OFFICIAL_API_REFERENCE_ONLY",
    FEE_PARSER: snapshots.some((pool) => pool.windows["1h"].fee !== null) ? "PARTIAL" : "UNAVAILABLE",
    ROUTE_SHARE: snapshots.some((pool) => pool.routeShareByWindow["1h"].share !== null) ? "PARTIAL" : "UNAVAILABLE",
    OFFICIAL_RECONCILIATION: "UNAVAILABLE",
  } satisfies IndexerStatusReport;
  const officialReconciliation = summarizeOfficialReconciliation(snapshots.length);
  indexerStatus.OFFICIAL_RECONCILIATION = officialReconciliation.status;
  const snapshot: DashboardSnapshot = {
    status: "LIVE_RWA_DATA_PARTIAL",
    generatedAt,
    network: "Solana Mainnet",
    pools: snapshots,
    pairs: [...new Set(snapshots.map((pool) => pool.pairKey))],
    discovery: {
      rwaAssetCount: discovery.rwaAssetCount,
      candidatePoolCount: discovery.candidatePoolCount,
      pairCount: discovery.pairCount,
      verifiedPoolCount: verifiedPools.length,
      apiStatus: discovery.apiStatus,
      apiUrl,
      officialPageUrl: "https://raydium.io/liquidity-pools/?type=RWA",
      discoveredAt: generatedAt,
      apiObservedAt,
      errors: discovery.errors.slice(0, 8),
      assetCoverage,
    },
    session,
    rpc,
    websocket,
    raydiumApi,
    swapIndexer,
    dataQuality,
    lastSwap,
    positions,
    calibration,
    ranking,
    publicMarket,
    statusReport: report,
    indexerStatus,
    officialReconciliation,
    wallet: { configured: Boolean(walletAddress), address: walletAddress, readOnly: true },
    alerts: [...discovery.errors, ...(persistedMetrics ? [] : ["独立 indexer worker 尚未完成短窗口回补"]), ...positionDiscovery.errors, ...(session.state === "盘中" ? [] : ["当前不是美股盘中，已降低价格发现置信度"])].slice(0, 8),
    snapshotSource: "LIVE",
    lastKnownGoodAt: generatedAt,
    localAccess: getLocalAccessInfo(),
  };
  if (discovery.apiStatus === "在线") persistIndexerState("last_known_good_snapshot", snapshot);
  cachedSnapshot = { expiresAt: Date.now() + 20_000, value: snapshot };
  latestSnapshot = snapshot;
  return snapshot;
}

export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  const persisted = readIndexerState<DashboardSnapshot>("last_known_good_snapshot");
  if (persisted?.pools?.length && !hasLegacyFullUniverseProgress(persisted)) {
    const hasPriceRangeFields = persisted.pools.every((pool) => Object.prototype.hasOwnProperty.call(pool, "price24hLow") && Object.prototype.hasOwnProperty.call(pool, "price24hHigh"));
    if (!hasPriceRangeFields) return collectDashboardSnapshot(false, { apiOnly: true });
    // 快照可以跨版本存活；不要把旧版 executableEstimates 当作事实层。
    // 每次读取公开市场快照都重算容量与 24h 可执行手续费，避免一个旧的
    // null 继续把官方 TVL/LP Fee 行退出排名。
    const snapshot = {
      ...persisted,
      pools: persisted.pools.map((pool) => refreshExecutableModels(pool)),
      snapshotSource: "LAST_KNOWN_GOOD" as const,
      lastKnownGoodAt: persisted.lastKnownGoodAt ?? persisted.generatedAt,
      localAccess: getLocalAccessInfo(),
    };
    cachedSnapshot = { expiresAt: Date.now() + 20_000, value: snapshot };
    latestSnapshot = snapshot;
    return snapshot;
  }
  return collectDashboardSnapshot(false, { apiOnly: true });
}

export async function refreshPublicMarketSnapshot(): Promise<DashboardSnapshot> {
  return collectDashboardSnapshot(true, { apiOnly: true });
}

export function clearDashboardSnapshotCache(): void {
  cachedSnapshot = null;
}

export function getLatestDashboardSnapshot(): DashboardSnapshot | null {
  return latestSnapshot;
}
