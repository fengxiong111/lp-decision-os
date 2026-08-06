import { CAPITAL_OPTIONS, type CapacityStatus, type DashboardSnapshot, type EventWindowCoverage, type PoolSnapshot } from "@/packages/models/src";
import { SHORT_WINDOW_POOL_LIMIT } from "@/services/indexer/universe";

export const TERMINAL_WINDOWS = ["1h", "6h", "12h", "24h"] as const;
export type TerminalWindow = (typeof TERMINAL_WINDOWS)[number];
type WindowState = "COMPLETE" | "PARTIAL" | "BACKFILLING" | "UNAVAILABLE";
type MetricState = "READY" | "PARTIAL" | "BACKFILLING" | "UNAVAILABLE";

export type RankingWindowStatus = {
  key: TerminalWindow;
  label: string;
  status: WindowState;
  state: "完整" | "部分完整" | "回补中" | "官方API" | "不可用";
  enabled: boolean;
  progress: number | null;
  coverage: number | null;
  completedPools: number | null;
  targetPools: number | null;
  universeLabel: string;
  updatedAt: string | null;
  source: string;
  reason: string | null;
};

export type RankingMetric = {
  value: number | null;
  status: MetricState;
  method: string | null;
  formula: string;
  missing: string[];
};

export type RankingCapacity = {
  status: CapacityStatus | "不可用";
  risk: "低" | "中" | "高" | "不可用";
  currentTvl: number | null;
  effectiveTvl: number | null;
  postDepositTvl: number | null;
  capital: number;
  capitalShare: number | null;
  dilution: number | null;
  recommendedMaxCapital: number | null;
  message: string;
  estimateMethod: string | null;
};

export type RankingPool = {
  poolAddress: string;
  baseMint: string;
  quoteMint: string;
  programId: string;
  poolType: PoolSnapshot["kind"];
  feeTier: string | null;
  tickSpacing: number | null;
  currentTick: number | null;
  currentPrice: number | null;
  price24hLow: number | null;
  price24hHigh: number | null;
  tvl: number | null;
  effectiveTvl: number | null;
  volume: number | null;
  lpFee: number | null;
  volume24h: number | null;
  lpFee24h: number | null;
  officialApr: number | null;
  poolRouteShare: number | null;
  pairVolume: number | null;
  pairPoolCount: number;
  rangePct: { lower: number; upper: number } | null;
  fullTicks: { lower: number; upper: number } | null;
  recommendedRange: string | null;
  capacity: RankingCapacity;
  estimatedFeeIncome: RankingMetric;
  estimatedNetProfit: RankingMetric;
  coverage: RankingWindowStatus;
  verificationStatus: PoolSnapshot["verificationStatus"];
  decision: "RECOMMEND" | "WATCH" | "REJECT" | "INSUFFICIENT_DATA";
  shortReason: string;
  rejectionReason: string | null;
  updatedAt: string;
  selected: boolean;
};

export type RankingPair = {
  pairId: string;
  symbol: string;
  underlying: string;
  recommendedPool: RankingPool | null;
  allPools: RankingPool[];
  recommendedRangePct: { lower: number; upper: number } | null;
  currentPrice: number | null;
  price24hLow: number | null;
  price24hHigh: number | null;
  tvl: number | null;
  effectiveTvl: number | null;
  volume: number | null;
  lpFee: number | null;
  volume24h: number | null;
  lpFee24h: number | null;
  poolRouteShare: number | null;
  estimatedFeeIncome: RankingMetric;
  estimatedNetProfit: RankingMetric;
  capacity: RankingCapacity;
  coverage: RankingWindowStatus;
  decision: "RECOMMEND" | "WATCH" | "REJECT" | "INSUFFICIENT_DATA";
  shortReason: string;
  updatedAt: string;
};

export type RankingResponse = {
  status: DashboardSnapshot["status"];
  capital: 1_000 | 10_000;
  window: TerminalWindow;
  rankingBasis: "NET_PROFIT" | "EXECUTABLE_FEE" | "LP_FEE_DENSITY";
  windowStatus: RankingWindowStatus;
  missingModelInputs: string[];
  pairs: RankingPair[];
  waitingPairs: RankingPair[];
  excludedPairCount: number;
  dataVersion: string;
  lastSwapAt: string | null;
  updatedAt: string;
};

const WINDOW_LABELS: Record<TerminalWindow, string> = { "1h": "1小时", "6h": "6小时", "12h": "12小时", "24h": "24小时" };
const CAPACITY_ORDER: Record<CapacityStatus | "不可用", number> = { 充足: 0, 偏小: 1, 过小: 2, 禁止: 3, "等待数据": 4, 不可用: 5 };

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizedCoverage(coverage: EventWindowCoverage | null | undefined): number | null {
  const raw = finite(coverage?.coverageRatio ?? coverage?.completeness);
  if (raw === null) return null;
  return raw > 1 ? Math.max(0, Math.min(1, raw / 100)) : Math.max(0, Math.min(1, raw));
}

function statusFromCoverage(coverage: EventWindowCoverage | null | undefined): WindowState {
  if (!coverage) return "UNAVAILABLE";
  const ratio = normalizedCoverage(coverage);
  if ((coverage.backfillStatus === "COMPLETE" || coverage.backfillStatus === "LIVE") && ratio === 1 && coverage.gapSlots === 0 && coverage.unknownInstructions === 0) return "COMPLETE";
  if (coverage.backfillStatus === "RUNNING" || coverage.backfillStatus === "BACKFILLING") return "BACKFILLING";
  if (ratio !== null || coverage.eventCount > 0 || coverage.signaturesDiscovered > 0) return "PARTIAL";
  return "UNAVAILABLE";
}

function displayState(status: WindowState, official = false): RankingWindowStatus["state"] {
  if (official) return "官方API";
  if (status === "COMPLETE") return "完整";
  if (status === "PARTIAL") return "部分完整";
  if (status === "BACKFILLING") return "回补中";
  return "不可用";
}

function toWindowStatus(snapshot: DashboardSnapshot, window: TerminalWindow, coverageOverride?: EventWindowCoverage | null): RankingWindowStatus {
  if (window === "24h") {
    const knownPoolCount = snapshot.pools.filter((pool) => pool.fee24h !== null || pool.volume24h !== null || pool.apr !== null).length;
    const available = knownPoolCount > 0;
    const officialCoverage = snapshot.pools.length > 0 ? knownPoolCount / snapshot.pools.length : null;
    return {
      key: window,
      label: WINDOW_LABELS[window],
      status: available ? "COMPLETE" : "UNAVAILABLE",
      state: displayState(available ? "COMPLETE" : "UNAVAILABLE", available),
      enabled: available,
      progress: officialCoverage === null ? null : Math.round(officialCoverage * 100),
      coverage: officialCoverage,
      completedPools: available ? knownPoolCount : null,
      targetPools: snapshot.pools.length,
      universeLabel: available ? `官方 API · ${knownPoolCount}/${snapshot.pools.length} 个 Pool 有数据` : "官方 API 未提供可展示数据",
      updatedAt: snapshot.generatedAt,
      source: "Raydium 官方 API v3 · 24h as_of",
      reason: available ? null : "官方24h数据不可用",
    };
  }
  const coverage = coverageOverride ?? snapshot.swapIndexer.windows[window];
  const status = statusFromCoverage(coverage);
  const ratio = normalizedCoverage(coverage);
  const progressRaw = finite(coverage?.timeCoverageRatio ?? coverage?.coverageRatio ?? coverage?.completeness);
  const completedPools = coverage?.completedPoolCount ?? null;
  const targetPools = coverage?.targetPoolCount ?? snapshot.pools.length;
  const universeLabel = completedPools !== null && targetPools !== null
    ? completedPools >= targetPools && targetPools > 0 ? `覆盖全部 ${targetPools} 个 Pool` : `覆盖 ${completedPools}/${targetPools} 个 Pool`
    : "活跃 Pool 分批回补中";
  return {
    key: window,
    label: WINDOW_LABELS[window],
    status,
    state: displayState(status),
    enabled: status !== "UNAVAILABLE",
    progress: progressRaw === null ? null : Math.round((progressRaw > 1 ? progressRaw / 100 : progressRaw) * 100),
    coverage: ratio,
    completedPools,
    targetPools,
    universeLabel,
    updatedAt: coverage?.lastEventTime ?? snapshot.generatedAt,
    source: "Solana RPC 交易回补",
      reason: status === "COMPLETE"
        ? null
        : coverage?.progressReason ?? (completedPools !== null ? `尚未完成历史覆盖，当前 ${completedPools}/${targetPools} 个 Pool` : "尚未完成历史覆盖"),
  };
}

function poolWindowStatus(snapshot: DashboardSnapshot, pool: PoolSnapshot, window: TerminalWindow): RankingWindowStatus {
  if (window === "24h") return toWindowStatus(snapshot, window);
  const own = pool.windowCoverage[window];
  const ownStatus = statusFromCoverage(own);
  // Pool-level rows are useful when present; otherwise retain the persisted aggregate progress.
  return ownStatus === "UNAVAILABLE" || (ownStatus === "BACKFILLING" && normalizedCoverage(own) === null)
    ? toWindowStatus(snapshot, window)
    : toWindowStatus(snapshot, window, own);
}

function metric(pool: PoolSnapshot, window: TerminalWindow) {
  const source = pool.windows[window];
  return {
    volume: source.volume ?? (window === "24h" ? pool.volume24h : null),
    fee: window === "24h" ? pool.fee24h ?? source.lpFeeUsd ?? source.fee : source.lpFeeUsd ?? source.fee,
  };
}

function estimate(pool: PoolSnapshot, capital: number, window: TerminalWindow) {
  return pool.executableEstimates[String(capital)]?.[window] ?? null;
}

function rankingMetric(value: number | null, status: MetricState, method: string | null, formula: string, missing: string[] = []): RankingMetric {
  return { value: finite(value), status, method, formula, missing };
}

function capacity(pool: PoolSnapshot, capital: number): RankingCapacity {
  const model = estimate(pool, capital, "24h");
  const effective = model?.activeTvlUsd ?? pool.effectiveActiveTvl ?? pool.tvl;
  const ratio = model?.capitalToActiveTvlRatio ?? (effective && effective > 0 ? capital / effective : null);
  const post = model?.postDepositTvlUsd ?? (effective !== null ? effective + capital : null);
  const status = model?.capacityStatus ?? "不可用";
  const risk = model?.risk ?? "不可用";
  const ratioText = ratio === null ? "等待有效 TVL" : `${(ratio * 100).toFixed(1)}%`;
  const message = status === "禁止"
    ? `投入占有效 TVL ${ratioText}，超过30%，禁止建仓`
    : status === "过小"
      ? `投入占有效 TVL ${ratioText}，容量过小，收益会明显稀释`
      : status === "偏小"
        ? `投入占有效 TVL ${ratioText}，容量偏小，需谨慎`
        : status === "充足"
          ? `投入占有效 TVL ${ratioText}，容量充足`
          : "等待有效 TVL，暂不判断容量";
  return {
    status,
    risk,
    currentTvl: pool.tvl,
    effectiveTvl: effective,
    postDepositTvl: post,
    capital,
    capitalShare: model?.userLiquidityShare ?? null,
    dilution: model?.earningsDilution ?? ratio,
    recommendedMaxCapital: model?.recommendedMaxCapitalUsd ?? (effective !== null ? effective * 0.3 : null),
    message,
    estimateMethod: model?.estimateMethod ?? null,
  };
}

function rangePct(pool: PoolSnapshot) {
  const detail = pool.rangeRecommendation;
  return detail ? { lower: detail.lowerPercent, upper: detail.upperPercent } : null;
}

function coverageIsReady(status: RankingWindowStatus) {
  return status.status === "COMPLETE";
}

function poolScore(pool: RankingPool): number {
  return pool.estimatedNetProfit.value ?? pool.estimatedFeeIncome.value ?? feeDensity(pool) ?? -Infinity;
}

function feeDensity(pool: Pick<RankingPool, "lpFee24h" | "tvl">): number | null {
  return pool.lpFee24h !== null && pool.tvl !== null && pool.tvl > 0 ? pool.lpFee24h / pool.tvl : null;
}

function comparePools(left: RankingPool, right: RankingPool, allowDensity = true): number {
  const leftUsable = (left.estimatedFeeIncome.value !== null || (allowDensity && feeDensity(left) !== null)) && left.capacity.status !== "禁止";
  const rightUsable = (right.estimatedFeeIncome.value !== null || (allowDensity && feeDensity(right) !== null)) && right.capacity.status !== "禁止";
  if (leftUsable !== rightUsable) return rightUsable ? 1 : -1;
  const leftScore = poolScore(left);
  const rightScore = poolScore(right);
  if (leftScore !== rightScore) return rightScore - leftScore;
  return CAPACITY_ORDER[left.capacity.status] - CAPACITY_ORDER[right.capacity.status]
    || (right.poolRouteShare ?? -Infinity) - (left.poolRouteShare ?? -Infinity)
    || (right.tvl ?? -Infinity) - (left.tvl ?? -Infinity);
}

function compactPool(snapshot: DashboardSnapshot, pool: PoolSnapshot, capital: number, window: TerminalWindow, selected: boolean, pairVolume: number | null, pairPoolCount: number): RankingPool {
  const estimateValue = estimate(pool, capital, window);
  const metricValue = metric(pool, window);
  const coverage = poolWindowStatus(snapshot, pool, window);
  const isOfficial = window === "24h";
  const feeReady = metricValue.fee !== null && (isOfficial || coverageIsReady(coverage));
  const expectedFee = estimateValue?.expectedLpFeeUsd ?? null;
  const feeStatus: MetricState = expectedFee !== null && feeReady
    ? "READY"
    : coverage.status === "BACKFILLING" ? "BACKFILLING"
      : coverage.status === "PARTIAL" ? "PARTIAL" : "UNAVAILABLE";
  const feeMissing = feeStatus === "READY"
    ? []
    : [window === "24h" ? "官方 API 未提供完整 TVL 与 LP Fee" : "回补中"];
  const netMissing = estimateValue?.missingModelInputs ?? ["净收益模型尚未完成：建仓/退出成本与 IL 未完成"];
  const poolRouteShare = finite(pool.routeShareByWindow[window].share);
  const selectedEligible = selected && feeStatus === "READY" && estimateValue?.capacityStatus !== "禁止";
  const decision: RankingPool["decision"] = estimateValue?.capacityStatus === "禁止"
    ? "REJECT"
    : selectedEligible ? "RECOMMEND"
      : feeStatus === "READY" ? "WATCH" : "INSUFFICIENT_DATA";
  const shortReason = estimateValue?.capacityStatus === "禁止"
    ? `投入 ${capital.toLocaleString("en-US")}U 占有效 TVL ${estimateValue.capitalToActiveTvlRatio === null || estimateValue.capitalToActiveTvlRatio === undefined ? "等待有效 TVL" : `${(estimateValue.capitalToActiveTvlRatio * 100).toFixed(1)}%`}，容量禁止`
    : feeStatus !== "READY"
      ? feeMissing[0] ?? "回补中"
      : `${poolRouteShare === null ? "Route Share暂无" : `承接 ${poolRouteShare.toFixed(1)}% 成交`}；${estimateValue?.capacityStatus === "充足" ? "容量充足" : estimateValue?.capacityStatus ? `容量${estimateValue.capacityStatus}` : "容量暂无"}；${expectedFee === null ? "预计手续费未计算" : `预计手续费 ${expectedFee.toFixed(2)}U`}`;
  return {
    poolAddress: pool.identity.poolAddress,
    baseMint: pool.identity.baseMint,
    quoteMint: pool.identity.quoteMint,
    programId: pool.programId,
    poolType: pool.kind,
    feeTier: pool.feeTier,
    tickSpacing: pool.tickSpacing,
    currentTick: pool.currentTick,
    currentPrice: pool.currentPrice,
    price24hLow: pool.price24hLow,
    price24hHigh: pool.price24hHigh,
    tvl: pool.tvl,
    effectiveTvl: pool.effectiveActiveTvl ?? pool.tvl,
    volume: metricValue.volume,
    lpFee: metricValue.fee,
    volume24h: pool.volume24h ?? pool.windows["24h"].volume ?? null,
    lpFee24h: pool.fee24h ?? pool.windows["24h"].lpFeeUsd ?? pool.windows["24h"].fee ?? null,
    officialApr: pool.apr ?? pool.feeApr,
    poolRouteShare,
    pairVolume,
    pairPoolCount,
    rangePct: rangePct(pool),
    fullTicks: pool.rangeRecommendation ? { lower: pool.rangeRecommendation.lowerTick, upper: pool.rangeRecommendation.upperTick } : null,
    recommendedRange: pool.recommendedRange,
    capacity: capacity(pool, capital),
    estimatedFeeIncome: rankingMetric(expectedFee, feeStatus, estimateValue?.estimateMethod ?? null, window === "24h" ? "24h LP Fee × capital / (TVL + capital) × conservative_range_factor(默认1)" : "窗口 LP Fee × 投入后流动性份额 × 区间概率 × 数据质量", feeMissing),
    estimatedNetProfit: rankingMetric(estimateValue?.netProfitUsd ?? null, estimateValue?.netProfitUsd !== null && estimateValue?.netProfitUsd !== undefined ? "READY" : "UNAVAILABLE", null, "预计 LP 手续费 − 建仓滑点 − 交易费 − 退出成本 − 再平衡成本 − IL − 区间外机会成本", netMissing),
    coverage,
    verificationStatus: pool.verificationStatus,
    decision,
    shortReason,
    rejectionReason: estimateValue?.capacityStatus === "禁止" ? capacity(pool, capital).message : null,
    updatedAt: pool.dataAt,
    selected,
  };
}

function pairReason(pool: RankingPool, capital: number, basis: RankingResponse["rankingBasis"]): string {
  if (pool.decision === "INSUFFICIENT_DATA") return pool.shortReason;
  if (pool.decision === "REJECT") return `放弃：${pool.capacity.message}`;
  const metric = basis === "NET_PROFIT"
    ? pool.estimatedNetProfit.value
    : basis === "EXECUTABLE_FEE" ? pool.estimatedFeeIncome.value : feeDensity(pool);
  const metricLabel = basis === "NET_PROFIT" ? "净利润" : basis === "EXECUTABLE_FEE" ? "手续费收入" : "LP Fee 密度";
  return `推荐 ${pool.feeTier ?? "Fee Tier暂无"} Pool：${pool.shortReason}${metric === null ? "；当前按字段可用性降级" : `；${metricLabel} ${metric.toFixed(4)}${basis === "LP_FEE_DENSITY" ? "" : "U"}`}`;
}

const PRIORITY_SYMBOLS = ["SPCX", "SPCXx", "NVDAX", "DRAM", "SPYx", "CRCLx", "SKHY", "TSLAx", "SNDK"] as const;

function shortWindowPoolIds(snapshot: DashboardSnapshot): Set<string> {
  const selected = new Set<string>();
  for (const symbol of PRIORITY_SYMBOLS) {
    const candidate = snapshot.pools
      .filter((pool) => pool.asset.symbol === symbol)
      .sort((left, right) => (right.volume24h ?? right.fee24h ?? -Infinity) - (left.volume24h ?? left.fee24h ?? -Infinity))[0];
    if (candidate) selected.add(candidate.identity.poolAddress);
  }
  for (const pool of [...snapshot.pools].sort((left, right) => (right.volume24h ?? -Infinity) - (left.volume24h ?? -Infinity))) {
    if (selected.size >= SHORT_WINDOW_POOL_LIMIT) break;
    selected.add(pool.identity.poolAddress);
  }
  return selected;
}

export function buildRankingResponse(snapshot: DashboardSnapshot, capital: 1_000 | 10_000, window: TerminalWindow): RankingResponse {
  const globalWindow = toWindowStatus(snapshot, window);
  const allowDensityFallback = window === "24h";
  const eligibleIds = window === "24h" ? null : shortWindowPoolIds(snapshot);
  const candidatePools = eligibleIds ? snapshot.pools.filter((pool) => eligibleIds.has(pool.identity.poolAddress)) : snapshot.pools;
  const groups = new Map<string, PoolSnapshot[]>();
  for (const pool of candidatePools) groups.set(pool.pairKey, [...(groups.get(pool.pairKey) ?? []), pool]);
  const rows = [...groups.entries()].map(([pairId, pools]) => {
    const pairMetrics = pools.map((pool) => metric(pool, window).volume);
    const pairVolume = pairMetrics.every((value) => value !== null) ? pairMetrics.reduce((sum, value) => sum + (value as number), 0) : null;
    const initial = pools.map((pool) => compactPool(snapshot, pool, capital, window, false, pairVolume, pools.length));
    const ordered = [...initial].sort((left, right) => comparePools(left, right, allowDensityFallback));
    const chosenAddress = ordered.find((pool) => pool.capacity.status !== "禁止" && (pool.estimatedFeeIncome.value !== null || (allowDensityFallback && feeDensity(pool) !== null)))?.poolAddress ?? null;
    const allPools = initial.map((pool) => compactPool(snapshot, pools.find((item) => item.identity.poolAddress === pool.poolAddress)!, capital, window, pool.poolAddress === chosenAddress, pairVolume, pools.length)).sort((left, right) => comparePools(left, right, allowDensityFallback));
    const selected = allPools.find((pool) => pool.poolAddress === chosenAddress) ?? null;
    const feeAvailable = allPools.some((pool) => pool.estimatedFeeIncome.value !== null && pool.capacity.status !== "禁止");
    const densityAvailable = allowDensityFallback && allPools.some((pool) => feeDensity(pool) !== null && pool.capacity.status !== "禁止");
    const netAvailable = allPools.some((pool) => pool.estimatedNetProfit.value !== null && pool.capacity.status !== "禁止");
    const basis: RankingResponse["rankingBasis"] = netAvailable ? "NET_PROFIT" : feeAvailable ? "EXECUTABLE_FEE" : allowDensityFallback ? "LP_FEE_DENSITY" : "EXECUTABLE_FEE";
    const decision: RankingPair["decision"] = !selected || (!feeAvailable && !densityAvailable)
      ? "INSUFFICIENT_DATA"
      : selected.decision === "REJECT" ? "REJECT" : selected.decision === "RECOMMEND" ? "RECOMMEND" : "WATCH";
    const finalSelected: RankingPool | null = selected ? { ...selected, decision, shortReason: pairReason(selected, capital, basis) } : null;
    const finalPools = allPools.map((pool) => pool.poolAddress === finalSelected?.poolAddress ? finalSelected : pool);
    return {
      pairId,
      symbol: `${pools[0]?.asset.symbol ?? "等待资产"}/USDC`,
      underlying: pools[0]?.asset.name ?? "等待资产名称",
      recommendedPool: finalSelected,
      allPools: finalPools,
      recommendedRangePct: finalSelected?.rangePct ?? null,
      currentPrice: finalSelected?.currentPrice ?? null,
      price24hLow: finalSelected?.price24hLow ?? null,
      price24hHigh: finalSelected?.price24hHigh ?? null,
      tvl: finalSelected?.tvl ?? null,
      effectiveTvl: finalSelected?.effectiveTvl ?? null,
      volume: finalSelected?.volume ?? null,
      lpFee: finalSelected?.lpFee ?? null,
      volume24h: finalSelected?.volume24h ?? null,
      lpFee24h: finalSelected?.lpFee24h ?? null,
      poolRouteShare: finalSelected?.poolRouteShare ?? null,
      estimatedFeeIncome: finalSelected?.estimatedFeeIncome ?? rankingMetric(null, "UNAVAILABLE", null, "官方 LP Fee × 投入后份额；TVL 比例估算，未扣除区间外影响", [window === "24h" ? "官方 API 未提供完整 TVL 与 LP Fee" : "回补中"]),
      estimatedNetProfit: finalSelected?.estimatedNetProfit ?? rankingMetric(null, "UNAVAILABLE", null, "预计 LP 手续费 − 建仓滑点 − 交易费 − 退出成本 − 再平衡成本 − IL − 区间外机会成本", ["等待净收益模型输入"]),
      capacity: finalSelected?.capacity ?? { status: "不可用", risk: "不可用", currentTvl: null, effectiveTvl: null, postDepositTvl: null, capital, capitalShare: null, dilution: null, recommendedMaxCapital: null, message: "等待有效 TVL 与容量核验", estimateMethod: null },
      coverage: finalSelected?.coverage ?? globalWindow,
      decision,
      shortReason: finalSelected?.shortReason ?? (window === "24h" ? "官方 API 未提供完整 TVL 与 LP Fee" : "回补中"),
      updatedAt: snapshot.generatedAt,
    } satisfies RankingPair;
  });
  const windowReady = (pool: RankingPool) => window === "24h" || pool.coverage.status === "COMPLETE";
  const rankedRows = rows.filter((row) => row.allPools.some((pool) => windowReady(pool) && pool.capacity.status !== "禁止" && (pool.estimatedFeeIncome.value !== null || (allowDensityFallback && feeDensity(pool) !== null))));
  const waitingRows = rows.filter((row) => !rankedRows.includes(row));
  const rankingBasis: RankingResponse["rankingBasis"] = rankedRows.some((row) => row.estimatedNetProfit.value !== null && row.decision !== "REJECT")
    ? "NET_PROFIT"
    : rankedRows.some((row) => row.estimatedFeeIncome.value !== null && row.decision !== "REJECT")
      ? "EXECUTABLE_FEE"
    : allowDensityFallback ? "LP_FEE_DENSITY" : "EXECUTABLE_FEE";
  rankedRows.sort((left, right) => {
    const leftPool = left.recommendedPool ?? left.allPools[0] ?? null;
    const rightPool = right.recommendedPool ?? right.allPools[0] ?? null;
    const leftUsable = (left.estimatedFeeIncome.value !== null || (allowDensityFallback && leftPool !== null && feeDensity(leftPool) !== null)) && (left.decision === "RECOMMEND" || left.decision === "WATCH");
    const rightUsable = (right.estimatedFeeIncome.value !== null || (allowDensityFallback && rightPool !== null && feeDensity(rightPool) !== null)) && (right.decision === "RECOMMEND" || right.decision === "WATCH");
    if (leftUsable !== rightUsable) return rightUsable ? 1 : -1;
    const leftScore = rankingBasis === "NET_PROFIT" ? left.estimatedNetProfit.value : rankingBasis === "EXECUTABLE_FEE" ? left.estimatedFeeIncome.value : leftPool ? feeDensity(leftPool) : null;
    const rightScore = rankingBasis === "NET_PROFIT" ? right.estimatedNetProfit.value : rankingBasis === "EXECUTABLE_FEE" ? right.estimatedFeeIncome.value : rightPool ? feeDensity(rightPool) : null;
    return (rightScore ?? -Infinity) - (leftScore ?? -Infinity)
      || CAPACITY_ORDER[left.capacity.status] - CAPACITY_ORDER[right.capacity.status]
      || (right.poolRouteShare ?? -Infinity) - (left.poolRouteShare ?? -Infinity);
  });
  const missingModelInputs = rankingBasis === "NET_PROFIT"
    ? []
    : rankingBasis === "EXECUTABLE_FEE"
      ? ["净收益模型尚未完成：建仓滑点、退出成本、再平衡成本与未来无常损失"]
      : ["TVL 或 LP Fee 缺失的 Pair 按 24h LP Fee 密度继续排序"]; 
  const lastSwapAt = snapshot.lastSwap?.blockTime ?? null;
  const dataVersion = [snapshot.generatedAt, lastSwapAt ?? "no-swap", window, capital].join(":");
  return { status: snapshot.status, capital, window, rankingBasis, windowStatus: globalWindow, missingModelInputs, pairs: rankedRows, waitingPairs: waitingRows, excludedPairCount: waitingRows.length, dataVersion, lastSwapAt, updatedAt: snapshot.generatedAt };
}

export function parseTerminalCapital(value: string | null): 1_000 | 10_000 {
  return value === "10000" ? 10_000 : 1_000;
}

export function parseTerminalWindow(value: string | null): TerminalWindow {
  return TERMINAL_WINDOWS.includes(value as TerminalWindow) ? value as TerminalWindow : "24h";
}

export { CAPITAL_OPTIONS };
