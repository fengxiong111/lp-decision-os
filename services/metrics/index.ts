import { CAPITAL_OPTIONS, WINDOW_KEYS, type CapacityStatus, type EventWindowCoverage, type ExecutableEstimate, type FeeReconciliation, type MarketSession, type PoolRecommendation, type PoolSnapshot, type PoolUniverseStatus, type PoolVerification, type PublicMarketLevel, type RangeRecommendation, type RouteShareMetric, type SourceRef, type SwapEventRecord, type WindowKey, type WindowMetric } from "@/packages/models/src";
import type { RaydiumPoolInfo } from "@/services/raydium/api";
import type { RaydiumPoolKeys, TickLine } from "@/services/raydium/keys";
import { USDC_MINT } from "@/services/raydium/config";
import { calculatePoolQuality } from "@/services/quality";
import type { ServiceHealth } from "@/packages/models/src";
import { coverageIsDeterministicallyComplete } from "@/services/indexer/progress";

type PoolBuildInput = {
  pool: RaydiumPoolInfo;
  keys: RaydiumPoolKeys | null;
  ticks: TickLine[];
  verification: PoolVerification;
  sources: SourceRef[];
  tickSource: SourceRef | null;
  swapEvents: SwapEventRecord[];
  websocket: ServiceHealth;
  session: MarketSession;
  apiAgeSeconds: number | null;
  rpcSlotLag: number | null;
  scannedForEvents: boolean;
  windowCoverage: Record<WindowKey, EventWindowCoverage>;
  publicApiAvailable: boolean;
  marketLevel: PublicMarketLevel;
  universeStatus: PoolUniverseStatus;
  universeReason: string;
};

const unavailable = (window: WindowKey, reason = "等待窗口回补：数据覆盖未完成"): WindowMetric => ({
  window,
  volume: null,
  fee: null,
  grossFeeUsd: null,
  lpFeeUsd: null,
  swapCount: null,
  buyVolumeUsd: null,
  sellVolumeUsd: null,
  uniqueWalletCount: null,
  tvlStart: null,
  tvlEnd: null,
  activeTvl: null,
  feeDensity: null,
  liquidityVelocity: null,
  routeShare: null,
  coverageRatio: null,
  status: "UNAVAILABLE",
  firstEventAt: null,
  lastEventAt: null,
  asOf: null,
  apr: null,
  source: "unavailable",
  sourceLabel: reason,
  observedAt: null,
  available: false,
});

const percent = (value: number | null): string | null => {
  if (value === null || !Number.isFinite(value)) return null;
  return `${(value * 100).toFixed(value * 100 < 1 ? 2 : 2)}%`;
};

const clamp = (value: number) => Math.max(0, Math.min(1, value));

function chooseTick(line: TickLine[], price: number | null): TickLine | null {
  if (line.length === 0 || price === null || price <= 0) return null;
  return [...line].sort((a, b) => Math.abs(Math.log(a.price / price)) - Math.abs(Math.log(b.price / price)))[0] ?? null;
}

function rangeOptions(pool: RaydiumPoolInfo): string[] {
  return pool.config?.defaultRangePoint.map((range) => `±${(range * 100).toFixed(range * 100 < 1 ? 2 : 0)}%`) ?? [];
}

function makeEventWindow(window: WindowKey, events: SwapEventRecord[], observedAt: string, effectiveActiveTvl: number | null, coverage: EventWindowCoverage): WindowMetric {
  const complete = window === "1h" || window === "6h" || window === "12h"
    ? coverageIsDeterministicallyComplete(coverage, window)
    : (coverage.backfillStatus === "COMPLETE" || coverage.backfillStatus === "LIVE") && coverage.coverageRatio !== null;
  if (!complete) {
    return unavailable(window, `等待 ${window} 回补：${coverage.backfillStatus}`);
  }
  if (events.length === 0) {
    return {
      window,
      volume: 0,
      fee: 0,
      grossFeeUsd: 0,
      lpFeeUsd: 0,
      swapCount: 0,
      buyVolumeUsd: 0,
      sellVolumeUsd: 0,
      uniqueWalletCount: 0,
      tvlStart: effectiveActiveTvl,
      tvlEnd: effectiveActiveTvl,
      activeTvl: effectiveActiveTvl,
      feeDensity: effectiveActiveTvl && effectiveActiveTvl > 0 ? 0 : null,
      liquidityVelocity: effectiveActiveTvl && effectiveActiveTvl > 0 ? 0 : null,
      routeShare: null,
      coverageRatio: coverage.coverageRatio ?? 100,
      status: coverage.backfillStatus === "LIVE" ? "LIVE" : "COMPLETE",
      firstEventAt: null,
      lastEventAt: null,
      asOf: observedAt,
      apr: effectiveActiveTvl && effectiveActiveTvl > 0 ? 0 : null,
      source: "event-index",
      sourceLabel: "完整窗口：真实零交易",
      observedAt,
      available: true,
    };
  }
  const volume = events.reduce((total, event) => total + event.volume, 0);
  const actualFeeComplete = events.every((event) => event.fee !== null && event.lpFeeAtomic !== null && event.feeUsd !== null);
  if (!actualFeeComplete) return unavailable(window, "等待逐笔实际 LP Fee 解析");
  const fee = events.reduce((total, event) => total + (event.fee ?? 0), 0);
  return {
    window,
    volume,
    fee,
    grossFeeUsd: fee,
    lpFeeUsd: fee,
    swapCount: events.length,
    buyVolumeUsd: null,
    sellVolumeUsd: null,
    uniqueWalletCount: new Set(events.flatMap((event) => event.trader ? [event.trader] : [])).size || null,
    tvlStart: effectiveActiveTvl,
    tvlEnd: effectiveActiveTvl,
    activeTvl: effectiveActiveTvl,
    feeDensity: effectiveActiveTvl && effectiveActiveTvl > 0 ? (fee / effectiveActiveTvl) * 100 : null,
    liquidityVelocity: effectiveActiveTvl && effectiveActiveTvl > 0 ? volume / effectiveActiveTvl : null,
    routeShare: null,
    coverageRatio: coverage.coverageRatio ?? 100,
    status: coverage.backfillStatus === "LIVE" ? "LIVE" : "COMPLETE",
    firstEventAt: coverage.firstEventAt,
    lastEventAt: coverage.lastEventAt,
    asOf: observedAt,
    apr: effectiveActiveTvl && effectiveActiveTvl > 0 ? (fee / effectiveActiveTvl) * 365 * 100 : null,
    source: "event-index",
    sourceLabel: "Solana RPC Swap 事件",
    observedAt: events[0]?.blockTime ?? observedAt,
    available: volume > 0,
  };
}

function makeWindows(pool: RaydiumPoolInfo, observedAt: string, swapEvents: SwapEventRecord[], effectiveActiveTvl: number | null, coverage: Record<WindowKey, EventWindowCoverage>): Record<WindowKey, WindowMetric> {
  const now = new Date(observedAt).getTime();
  const eventsFor = (seconds: number) => swapEvents.filter((event) => {
    const age = now - new Date(event.blockTime).getTime();
    return age >= 0 && age <= seconds * 1000;
  });
  return {
    "1m": makeEventWindow("1m", eventsFor(60), observedAt, effectiveActiveTvl, coverage["1m"]),
    "5m": makeEventWindow("5m", eventsFor(5 * 60), observedAt, effectiveActiveTvl, coverage["5m"]),
    "30m": makeEventWindow("30m", eventsFor(30 * 60), observedAt, effectiveActiveTvl, coverage["30m"]),
    "1h": makeEventWindow("1h", eventsFor(60 * 60), observedAt, effectiveActiveTvl, coverage["1h"]),
    "6h": makeEventWindow("6h", eventsFor(6 * 60 * 60), observedAt, effectiveActiveTvl, coverage["6h"]),
    "12h": makeEventWindow("12h", eventsFor(12 * 60 * 60), observedAt, effectiveActiveTvl, coverage["12h"]),
  "24h": {
      window: "24h",
      volume: pool.day.volume,
      fee: pool.day.volumeFee,
      grossFeeUsd: pool.day.volumeFee,
      lpFeeUsd: pool.day.volumeFee,
      swapCount: null,
      buyVolumeUsd: null,
      sellVolumeUsd: null,
      uniqueWalletCount: null,
      tvlStart: pool.tvl,
      tvlEnd: pool.tvl,
      activeTvl: pool.tvl,
      feeDensity: pool.day.volumeFee !== null && pool.tvl !== null && pool.tvl > 0 ? (pool.day.volumeFee / pool.tvl) * 100 : null,
      liquidityVelocity: pool.day.volume !== null && pool.tvl !== null && pool.tvl > 0 ? pool.day.volume / pool.tvl : null,
      routeShare: null,
      coverageRatio: pool.day.volume !== null || pool.day.volumeFee !== null || pool.day.apr !== null ? 100 : null,
      firstEventAt: null,
      lastEventAt: null,
      asOf: observedAt,
      apr: pool.day.apr,
      status: pool.day.volumeFee !== null || pool.day.volume !== null ? "COMPLETE" : "UNAVAILABLE",
      source: "raydium-api-v3",
      sourceLabel: pool.day.volume !== null || pool.day.volumeFee !== null || pool.day.apr !== null
        ? "Raydium v3 官方24h · API as_of"
        : "官方 API 未提供 24h 数据",
      observedAt,
      available: pool.day.volume !== null || pool.day.volumeFee !== null || pool.day.apr !== null,
    },
  };
}

function unavailableFeeReconciliation(): FeeReconciliation {
  return {
    status: "UNAVAILABLE",
    routeASwapLpFeeAtomic: null,
    routeBPoolFeeGrowthAtomic: null,
    routeBPositionFeeGrowthAtomic: null,
    tokenAtomicDifference: null,
    usdDifferencePercent: null,
    toleranceTokenAtomic: "1",
    toleranceUsdPercent: 0.5,
    failureReason: "逐笔 Swap LP Fee 与 fee_growth_global 尚未完成双路线对账",
    checkedAt: null,
  };
}

function alignTick(value: number, spacing: number, direction: "down" | "up"): number {
  const aligned = direction === "down" ? Math.floor(value / spacing) * spacing : Math.ceil(value / spacing) * spacing;
  return Number.isFinite(aligned) ? aligned : value;
}

function buildRangeRecommendation(
  pool: RaydiumPoolInfo,
  ticks: TickLine[],
  currentTick: number | null,
  rawPrice: number | null,
  displayPrice: number | null,
  assetIsA: boolean,
): { label: string | null; detail: RangeRecommendation | null } {
  if (pool.kind !== "CLMM" || ticks.length === 0 || currentTick === null || rawPrice === null || rawPrice <= 0 || displayPrice === null || displayPrice <= 0) return { label: null, detail: null };
  const spacing = Math.max(1, pool.config?.tickSpacing ?? 1);
  const configured = pool.config?.defaultRangePoint ?? [];
  const candidates = [...new Set([...configured, 0.01, 0.02, 0.03, 0.05, 0.08].filter((value) => value > 0 && value < 1))].sort((a, b) => a - b);
  const logTick = Math.log(1.0001);
  const scored = candidates.map((range) => {
    const lowerTick = alignTick(currentTick + Math.log(1 - range) / logTick, spacing, "down");
    const upperTick = alignTick(currentTick + Math.log(1 + range) / logTick, spacing, "up");
    const inRange = ticks.filter((item) => item.tick >= lowerTick && item.tick <= upperTick);
    const liquiditySum = inRange.reduce((total, item) => total + Math.max(0, item.liquidity), 0);
    const density = inRange.length > 0 ? liquiditySum / Math.max(1, upperTick - lowerTick) : -Infinity;
    return { range, lowerTick, upperTick, density, inRangeCount: inRange.length };
  });
  const best = [...scored].sort((a, b) => b.density - a.density || a.range - b.range)[0];
  if (!best || !Number.isFinite(best.density) || best.inRangeCount === 0) return { label: null, detail: null };
  const rawLowerPrice = rawPrice * Math.pow(1.0001, best.lowerTick - currentTick);
  const rawUpperPrice = rawPrice * Math.pow(1.0001, best.upperTick - currentTick);
  const lowerPrice = assetIsA ? rawLowerPrice : 1 / rawUpperPrice;
  const upperPrice = assetIsA ? rawUpperPrice : 1 / rawLowerPrice;
  const lowerPercent = (lowerPrice / displayPrice - 1) * 100;
  const upperPercent = (upperPrice / displayPrice - 1) * 100;
  const detail: RangeRecommendation = {
    lowerTick: best.lowerTick,
    upperTick: best.upperTick,
    lowerPrice,
    upperPrice,
    lowerPercent,
    upperPercent,
    candidateCount: candidates.length,
    inRangeTimePercent: null,
    rebalanceCount24h: null,
    method: "Raydium Tick 线流动性密度；边界按 Tick spacing 对齐",
  };
  const signed = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
  return { label: `${signed(lowerPercent)} ～ ${signed(upperPercent)} · Tick ${best.lowerTick}–${best.upperTick}`, detail };
}

function emptyRouteShare(window: WindowKey, pairPoolCount: number, observedAt: string): RouteShareMetric {
  return {
    share: null,
    pairPoolCount,
    windowActivePoolCount: 0,
    denominatorVolume: null,
    poolVolume: null,
    unattributedVolume: null,
    source: window === "24h" ? "Raydium v3 day" : "SQLite Swap 事件索引",
    observedAt,
  };
}

function apiDayPrice(pool: RaydiumPoolInfo, key: "priceMin" | "priceMax"): number | null {
  const direct = pool.day[key];
  if (direct !== null && Number.isFinite(direct)) return direct;
  const raw = pool.raw;
  const rawDay = typeof raw.day === "object" && raw.day !== null ? raw.day as Record<string, unknown> : null;
  const value = rawDay?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function capacityForRatio(ratio: number | null): { status: CapacityStatus; risk: ExecutableEstimate["risk"] } {
  if (ratio === null) return { status: "等待数据", risk: "不可用" };
  if (ratio > 0.3) return { status: "禁止", risk: "高" };
  if (ratio > 0.15) return { status: "过小", risk: "高" };
  if (ratio > 0.05) return { status: "偏小", risk: "中" };
  return { status: "充足", risk: "低" };
}

function executableEstimate(pool: PoolSnapshot, capitalUsd: number, window: WindowKey): ExecutableEstimate {
  const metric = pool.windows[window];
  const activeTvlUsd = pool.effectiveActiveTvl ?? pool.tvl;
  const postDepositTvlUsd = activeTvlUsd !== null ? activeTvlUsd + capitalUsd : null;
  const capitalToActiveTvlRatio = activeTvlUsd !== null && activeTvlUsd > 0 ? capitalUsd / activeTvlUsd : null;
  const userLiquidityShare = activeTvlUsd !== null && activeTvlUsd > 0 ? capitalUsd / (activeTvlUsd + capitalUsd) : null;
  const earningsDilution = capitalToActiveTvlRatio === null ? null : capitalToActiveTvlRatio;
  const hasTickLiquidity = pool.kind !== "CLMM" || (pool.activeLiquidityRatio !== null && Number.isFinite(pool.activeLiquidityRatio));
  // 24h 官方 API 数据是可执行排名的最低可用事实层。没有 Tick 证据时，
  // 使用 conservative_range_factor=1，而不是把整行标成未知；短窗口仍然
  // 继续要求本地窗口事实完整，避免把历史 API 数字冒充链上实时数据。
  const inRangeProbability = window === "24h"
    ? pool.kind === "CLMM" && pool.activeLiquidityRatio !== null ? pool.activeLiquidityRatio : 1
    : pool.kind === "CLMM" ? pool.activeLiquidityRatio : 1;
  const capacity = capacityForRatio(capitalToActiveTvlRatio);
  const lpFeeUsd = window === "24h" ? pool.fee24h ?? metric.lpFeeUsd ?? metric.fee : metric.lpFeeUsd ?? metric.fee;
  const measuredQualityFactor = pool.confidence !== null && Number.isFinite(pool.confidence)
    ? Math.max(0.5, Math.min(1, pool.confidence / 100))
    : null;
  // 官方 24h 估算必须能在 RPC/Tick/短窗口缺失时给出具体答案。质量分数只
  // 作为说明信息；公开 API 事实层不因高级指标未完成而退出。
  const shortWindowComplete = window === "1h" || window === "6h" || window === "12h"
    ? (metric.status === "COMPLETE" || metric.status === "LIVE") && (metric.coverageRatio === null || metric.coverageRatio >= 100)
    : false;
  const dataQualityFactor = window === "24h" || shortWindowComplete ? 1 : measuredQualityFactor;
  const exactShortWindowEstimate = shortWindowComplete
    && lpFeeUsd !== null
    && userLiquidityShare !== null;
  const expectedLpFeeUsd = exactShortWindowEstimate
    ? (lpFeeUsd as number) * (userLiquidityShare as number)
    : lpFeeUsd !== null && userLiquidityShare !== null && inRangeProbability !== null && dataQualityFactor !== null
      ? lpFeeUsd * userLiquidityShare * inRangeProbability * dataQualityFactor
    : null;
  const feeUnavailable = lpFeeUsd === null || (window !== "24h" && !shortWindowComplete && !metric.available);
  const estimateMethod: ExecutableEstimate["estimateMethod"] = window === "24h"
    ? hasTickLiquidity ? "OFFICIAL_24H" : "TVL_CONSERVATIVE"
    : hasTickLiquidity ? "TICK_LEVEL" : "TVL_CONSERVATIVE";
  const missingModelInputs = feeUnavailable
    ? [`${window} 窗口交易覆盖尚未完整，不能使用短窗口手续费`]
    : ["建仓滑点、退出成本、再平衡成本与未来无常损失模型尚未完成"];
  const reason = capitalToActiveTvlRatio === null
    ? "有效 TVL 不可用，不能计算投入后的容量"
      : capacity.status === "禁止"
      ? `投入金额占现有有效 TVL ${(capitalToActiveTvlRatio * 100).toFixed(1)}%，超过30%容量上限`
      : feeUnavailable
        ? missingModelInputs[0]
    : exactShortWindowEstimate
      ? `${window} 实际 LP Fee × capital / (TVL + capital)；容量稀释已纳入`
    : window === "24h" && inRangeProbability === 1
      ? `24h LP Fee × 投入后份额；TVL 比例估算，未扣除区间外影响`
      : `LP Fee × 投入后份额 × 区间概率 × 数据质量 ${dataQualityFactor === null ? "等待数据质量" : `${(dataQualityFactor * 100).toFixed(0)}%`}`;
  return {
    capitalUsd,
    window,
    activeTvlUsd,
    postDepositTvlUsd,
    capitalToActiveTvlRatio,
    userLiquidityShare,
    earningsDilution,
    inRangeProbability,
    dataQualityFactor,
    estimateMethod,
    expectedLpFeeUsd,
    entrySlippageUsd: null,
    tradingFeeUsd: null,
    priorityFeeUsd: null,
    exitCostUsd: null,
    rebalanceCostUsd: null,
    impermanentLossUsd: null,
    opportunityCostUsd: null,
    netProfitUsd: null,
    netReturnPct: null,
    missingModelInputs,
    recommendedMaxCapitalUsd: activeTvlUsd !== null ? activeTvlUsd * 0.3 : null,
    capacityStatus: capacity.status,
    risk: capacity.risk,
    status: capacity.status === "禁止" ? "CAPACITY_BLOCKED" : feeUnavailable ? "FEE_UNAVAILABLE" : "NET_MODEL_UNAVAILABLE",
    reason,
    formulaVersion: "executable-capacity-v1",
  };
}

function buildExecutableEstimates(pool: PoolSnapshot): Record<string, Record<WindowKey, ExecutableEstimate>> {
  return Object.fromEntries(CAPITAL_OPTIONS.map((capital) => [String(capital), Object.fromEntries(WINDOW_KEYS.map((window) => [window, executableEstimate(pool, capital, window)]))])) as Record<string, Record<WindowKey, ExecutableEstimate>>;
}

export function refreshExecutableModels(pool: PoolSnapshot): PoolSnapshot {
  const executableEstimates = buildExecutableEstimates(pool);
  const recommendations: Record<string, PoolRecommendation> = Object.fromEntries(CAPITAL_OPTIONS.map((capital) => {
    const estimate = executableEstimates[String(capital)]["1h"];
    return [String(capital), {
      verdict: (estimate.capacityStatus === "禁止" ? "放弃" : estimate.status === "READY" && estimate.netProfitUsd !== null ? "推荐" : "观察") as PoolRecommendation["verdict"],
      reason: estimate.reason,
      capitalUsd: capital,
      window: "1h" as const,
    }];
  }));
  return { ...pool, executableEstimates, recommendations };
}

export function buildPoolSnapshots(inputs: PoolBuildInput[], observedAt: string): PoolSnapshot[] {
  const preliminary = inputs.map(({ pool, keys, ticks, verification, sources, tickSource, swapEvents, websocket, session, apiAgeSeconds, rpcSlotLag, scannedForEvents, windowCoverage, publicApiAvailable, marketLevel, universeStatus, universeReason }) => {
    const assetIsA = pool.mintA.address !== USDC_MINT;
    const asset = assetIsA ? pool.mintA : pool.mintB;
    const quote = assetIsA ? pool.mintB : pool.mintA;
    const rawPrice = pool.price !== null && pool.price > 0 ? pool.price : null;
    const currentPrice = rawPrice === null ? null : assetIsA ? rawPrice : 1 / rawPrice;
    const apiPriceMin = apiDayPrice(pool, "priceMin");
    const apiPriceMax = apiDayPrice(pool, "priceMax");
    const price24hLow = apiPriceMin === null || apiPriceMin <= 0 || apiPriceMax === null || apiPriceMax <= 0
      ? null
      : assetIsA ? apiPriceMin : 1 / apiPriceMax;
    const price24hHigh = apiPriceMin === null || apiPriceMin <= 0 || apiPriceMax === null || apiPriceMax <= 0
      ? null
      : assetIsA ? apiPriceMax : 1 / apiPriceMin;
    const tick = chooseTick(ticks, rawPrice);
    const maxLiquidity = ticks.length > 0 ? Math.max(...ticks.map((item) => item.liquidity)) : null;
    const activeLiquidity = tick?.liquidity ?? null;
    const activeLiquidityRatio = maxLiquidity !== null && maxLiquidity > 0 && activeLiquidity !== null
      ? clamp(activeLiquidity / maxLiquidity)
      : null;
    const effectiveActiveTvl = pool.tvl !== null && activeLiquidityRatio !== null ? pool.tvl * activeLiquidityRatio : null;
    const feeApr = pool.day.feeApr;
    const publicTvl = pool.tvl !== null && pool.tvl > 0 ? pool.tvl : null;
    const feeDensityBaseTvl = effectiveActiveTvl ?? publicTvl;
    const grossYieldApr = pool.day.volumeFee !== null && feeDensityBaseTvl && feeDensityBaseTvl > 0
      ? (pool.day.volumeFee / feeDensityBaseTvl) * 365 * 100
      : feeApr;
    const apy = feeApr === null ? null : (Math.pow(1 + Math.max(0, feeApr) / 100 / 365, 365) - 1) * 100;
    const windows = makeWindows(pool, observedAt, swapEvents, effectiveActiveTvl, windowCoverage);
    const feeReconciliation = unavailableFeeReconciliation();
    const windowCoverageCount = WINDOW_KEYS.filter((key) => key !== "24h" && windows[key].available).length;
    const poolSources = [...sources, ...(tickSource ? [tickSource] : [])];
    const baseQuality = calculatePoolQuality({
      verification,
      apiAvailable: pool.day.volume !== null || pool.day.volumeFee !== null || pool.tvl !== null,
      tickAvailable: ticks.length > 0,
      websocket,
      apiAgeSeconds,
      rpcSlotLag,
      swapSampleCount: swapEvents.length,
      windowCoverageCount,
      scannedForEvents,
      sessionAdjustment: session.confidenceAdjustment,
      sources: poolSources,
    });
    const quality = publicApiAvailable
      ? {
          ...baseQuality,
          reasons: [...new Set(["官方 API 公开市场数据可用", ...baseQuality.reasons.filter((reason) => !reason.includes("尚未进入事件回补队列"))])],
          details: { ...baseQuality.details, dataLevel: marketLevel, publicData: "Raydium v3 API" },
        }
      : baseQuality;
    const range = buildRangeRecommendation(pool, ticks, tick?.tick ?? null, rawPrice, currentPrice, assetIsA);
    const baseSnapshot = {
      id: pool.id,
      pair: `${asset.symbol} / USDC`,
      pairKey: asset.address,
      universeStatus,
      universeReason,
      identity: { baseMint: asset.address, quoteMint: USDC_MINT, poolAddress: pool.id, positionNftMint: null },
      asset: { symbol: asset.symbol, name: asset.name, mint: asset.address, decimals: asset.decimals },
      issuer: asset.issuer,
      quote: { symbol: "USDC" as const, mint: USDC_MINT, decimals: quote.decimals },
      protocol: "raydium" as const,
      kind: pool.kind,
      programId: pool.programId,
      feeRate: pool.feeRate,
      feeTier: percent(pool.feeRate),
      dynamicFee: pool.hasDynamicFee,
      configId: pool.config?.id ?? keys?.configId ?? null,
      tickSpacing: pool.config?.tickSpacing ?? null,
      currentTick: tick?.tick ?? null,
      sqrtPrice: currentPrice === null ? null : Math.sqrt(currentPrice),
      currentPrice,
      price24hLow,
      price24hHigh,
      liquidity: maxLiquidity,
      activeLiquidity,
      activeLiquidityRatio,
      tvl: pool.tvl,
      effectiveActiveTvl,
      vaults: { a: keys?.vaultA ?? null, b: keys?.vaultB ?? null },
      windows,
      volume24h: pool.day.volume,
      fee24h: pool.day.volumeFee,
      predictedFee24h: pool.day.volumeFee,
      feeApr,
      apr: pool.day.apr,
      apy,
      routeShare: null,
      routeShareByWindow: Object.fromEntries(WINDOW_KEYS.map((key) => [key, emptyRouteShare(key, 1, observedAt)])) as Record<WindowKey, RouteShareMetric>,
      feeDensity: publicApiAvailable && windows["24h"].available && pool.day.volumeFee !== null && feeDensityBaseTvl && feeDensityBaseTvl > 0 ? (pool.day.volumeFee / feeDensityBaseTvl) * 100 : null,
      velocity: windows["24h"].available && pool.day.volume !== null && feeDensityBaseTvl && feeDensityBaseTvl > 0 ? pool.day.volume / feeDensityBaseTvl : null,
      grossYieldApr: publicApiAvailable && windows["24h"].available ? grossYieldApr : null,
      expectedNetYield: null,
      executableEstimates: {},
      recommendations: {},
      rangeOptions: rangeOptions(pool),
      recommendedRange: range.label,
      rangeRecommendation: range.detail,
      feeReconciliation,
      marketLevel,
      verificationStatus: verification.programVerified && verification.mintsVerified && verification.vaultsVerified ? "已核验" : publicApiAvailable ? "待核验" : "不可用",
      windowCoverage,
      confidence: quality.score,
      quality,
      verification,
      sources: poolSources,
      dataAt: observedAt,
    } satisfies PoolSnapshot;
    return refreshExecutableModels(baseSnapshot);
  });

  const poolsByPair = new Map<string, PoolSnapshot[]>();
  for (const pool of preliminary) {
    const samePair = poolsByPair.get(pool.pairKey) ?? [];
    samePair.push(pool);
    poolsByPair.set(pool.pairKey, samePair);
  }
  return preliminary.map((pool) => {
    const samePair = poolsByPair.get(pool.pairKey) ?? [pool];
    const routeShareByWindow = Object.fromEntries(WINDOW_KEYS.map((window) => {
      const volumes = samePair.map((item) => item.windows[window].volume).filter((value): value is number => value !== null && Number.isFinite(value) && value > 0);
      const denominatorVolume = volumes.length > 0 ? volumes.reduce((total, value) => total + value, 0) : null;
      const poolVolume = pool.windows[window].volume;
      const windowActivePoolCount = volumes.length;
      const complete = volumes.length === samePair.length;
      return [window, {
        share: denominatorVolume !== null && poolVolume !== null ? (poolVolume / denominatorVolume) * 100 : null,
        pairPoolCount: samePair.length,
        windowActivePoolCount,
        denominatorVolume,
        poolVolume,
        unattributedVolume: complete ? 0 : null,
        source: window === "24h" ? "Raydium v3 day" : "SQLite Swap 事件索引",
        observedAt,
      } satisfies RouteShareMetric];
    })) as Record<WindowKey, RouteShareMetric>;
    return {
      ...pool,
      routeShare: routeShareByWindow["24h"].share,
      routeShareByWindow,
    };
  });
}
