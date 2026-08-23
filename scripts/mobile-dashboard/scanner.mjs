const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RAYDIUM_URL = "https://api-v3.raydium.io/pools/info/list-v2";
const METEORA_URL = "https://dlmm.datapi.meteora.ag/pools";

export const SCANNER_SOURCES = Object.freeze({
  raydium: RAYDIUM_URL,
  meteora: METEORA_URL,
});

export const SCANNER_FILTERS = Object.freeze({
  tvlMin: 50_000,
  volume24hMin: 50_000,
  maxApr24h: 10_000,
  maxFeeTvlRatio24h: 0.5,
});

export const SCANNER_LIMITS = Object.freeze({
  top10: 10,
  display: 5,
  pageSize: 1_000,
  maxRaydiumPages: 200,
  maxMeteoraPages: 250,
  apiConcurrency: 6,
});

const RAYDIUM_CORE_WIDTHS = Object.freeze([0.0025, 0.005, 0.01, 0.02]);
const RAYDIUM_BUFFER_WIDTHS = Object.freeze([0.05, 0.1, 0.2]);
const RAYDIUM_ALLOCATIONS = Object.freeze([
  Object.freeze({ core: 0.8, buffer: 0.2 }),
  Object.freeze({ core: 0.7, buffer: 0.3 }),
  Object.freeze({ core: 0.6, buffer: 0.4 }),
]);
const METEORA_MODES = Object.freeze(["Spot", "Curve", "Bid Ask"]);
const METEORA_BIN_STEPS = Object.freeze({
  LOW_VOL: [10, 20, 35],
  NORMAL_VOL: [20, 35, 50],
  HIGH_VOL: [50, 75, 100],
  UNKNOWN_VOL: [20, 50, 100],
});

function finite(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function string(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function pairLabel(left, right) {
  const leftSymbol = string(left?.symbol) || string(left?.address)?.slice(0, 8) || "未知资产";
  const rightSymbol = string(right?.symbol) || string(right?.address)?.slice(0, 8) || "未知报价";
  return `${leftSymbol}/${rightSymbol}`;
}

function orderedMints(first, second) {
  if (first?.address === USDC_MINT) return { base: second, quote: first };
  if (second?.address === USDC_MINT) return { base: first, quote: second };
  return { base: first, quote: second };
}

function fetchOptions() {
  return { headers: { accept: "application/json" } };
}

async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url, fetchOptions());
  if (!response.ok) throw new Error(`官方数据源 HTTP ${response.status}: ${url}`);
  return response.json();
}

async function mapWithConcurrency(values, limit, mapper) {
  const output = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return output;
}

export async function fetchRaydiumClmmUniverse({ fetchImpl = fetch, pageSize = SCANNER_LIMITS.pageSize, maxPages = SCANNER_LIMITS.maxRaydiumPages } = {}) {
  const pools = [];
  let nextPageId = null;
  let pageCount = 0;
  let complete = false;
  const seenCursors = new Set();

  while (pageCount < maxPages) {
    const params = new URLSearchParams({
      size: String(pageSize),
      hasReward: "false",
      sortField: "volume24h",
      sortType: "desc",
      poolType: "Concentrated",
    });
    if (nextPageId) params.set("nextPageId", nextPageId);
    const payload = await fetchJson(`${RAYDIUM_URL}?${params}`, fetchImpl);
    const page = Array.isArray(payload?.data?.data) ? payload.data.data : [];
    pools.push(...page);
    pageCount += 1;
    const cursor = string(payload?.data?.nextPageId);
    if (!cursor || seenCursors.has(cursor)) {
      complete = true;
      break;
    }
    seenCursors.add(cursor);
    nextPageId = cursor;
  }

  return {
    dex: "Raydium",
    poolType: "CLMM",
    pools,
    pageCount,
    complete,
    endpoint: RAYDIUM_URL,
    pageSize,
  };
}

export async function fetchMeteoraDlmmUniverse({ fetchImpl = fetch, pageSize = SCANNER_LIMITS.pageSize, maxPages = SCANNER_LIMITS.maxMeteoraPages } = {}) {
  const firstParams = new URLSearchParams({
    page: "1",
    page_size: String(pageSize),
    sort_by: "volume_24h:desc",
    filter_by: "is_blacklisted=false",
  });
  const first = await fetchJson(`${METEORA_URL}?${firstParams}`, fetchImpl);
  const pages = Math.max(1, Number(first?.pages) || 1);
  const pageCount = Math.min(pages, maxPages);
  const pageNumbers = Array.from({ length: pageCount - 1 }, (_, index) => index + 2);
  const rest = await mapWithConcurrency(pageNumbers, SCANNER_LIMITS.apiConcurrency, (page) => {
    const params = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize),
      sort_by: "volume_24h:desc",
      filter_by: "is_blacklisted=false",
    });
    return fetchJson(`${METEORA_URL}?${params}`, fetchImpl);
  });
  const pagesData = [first, ...rest];
  const pools = pagesData.flatMap((page) => Array.isArray(page?.data) ? page.data : []);
  return {
    dex: "Meteora",
    poolType: "DLMM",
    pools,
    total: finite(first?.total),
    pageCount,
    complete: pageCount >= pages,
    endpoint: METEORA_URL,
    pageSize,
  };
}

function normalizeRaydiumPool(raw) {
  const mintA = raw?.mintA ?? {};
  const mintB = raw?.mintB ?? {};
  const { base, quote } = orderedMints(mintA, mintB);
  const tvl = finite(raw?.tvl);
  const volume24h = finite(raw?.day?.volume);
  const lpFee24h = finite(raw?.day?.volumeFee);
  const currentPrice = finite(raw?.price);
  const priceMin = finite(raw?.day?.priceMin);
  const priceMax = finite(raw?.day?.priceMax);
  const priceVolatilityPct = currentPrice !== null && priceMin !== null && priceMax !== null && currentPrice > 0
    ? ((priceMax - priceMin) / currentPrice) * 100
    : null;
  return {
    dex: "Raydium",
    poolType: "CLMM",
    poolAddress: string(raw?.id),
    programId: string(raw?.programId),
    pair: pairLabel(base, quote),
    baseMint: string(base?.address),
    quoteMint: string(quote?.address),
    baseSymbol: string(base?.symbol),
    quoteSymbol: string(quote?.symbol),
    tvl,
    volume24h,
    lpFee24h,
    feeTier: finite(raw?.feeRate),
    apr24h: finite(raw?.day?.apr ?? raw?.day?.feeApr),
    volumeTvl: tvl !== null && tvl > 0 && volume24h !== null ? volume24h / tvl : null,
    feeTvl: tvl !== null && tvl > 0 && lpFee24h !== null ? lpFee24h / tvl : null,
    currentPrice,
    priceMin,
    priceMax,
    priceVolatilityPct,
    activeTimeHours: null,
    activeTimeSource: "官方 Pool 列表未提供逐小时活跃时长",
    tickSpacing: finite(raw?.config?.tickSpacing),
    currentTick: null,
    binStep: null,
    isBlacklisted: false,
    tags: Array.isArray(raw?.tips) ? raw.tips : [],
    washVolumeStatus: "NOT_VERIFIED",
    source: "Raydium API v3",
    sourceRecord: raw,
    replayEvidence: raw?.replayEvidence ?? null,
  };
}

function normalizeMeteoraPool(raw) {
  const tokenX = raw?.token_x ?? {};
  const tokenY = raw?.token_y ?? {};
  const quoteIsX = tokenX?.address === USDC_MINT;
  const quoteIsY = tokenY?.address === USDC_MINT;
  const base = quoteIsX ? tokenY : tokenX;
  const quote = quoteIsX ? tokenX : quoteIsY ? tokenY : tokenY;
  const tvl = finite(raw?.tvl);
  const volume24h = finite(raw?.volume?.["24h"]);
  const lpFee24h = finite(raw?.fees?.["24h"]);
  const feeTvl = finite(raw?.fee_tvl_ratio?.["24h"])
    ?? (tvl !== null && tvl > 0 && lpFee24h !== null ? lpFee24h / tvl : null);
  const baseFeePct = finite(raw?.pool_config?.base_fee_pct);
  const dynamicFee = finite(raw?.dynamic_fee_pct);
  const baseFee = baseFeePct === null ? null : baseFeePct / 100;
  const feeTier = dynamicFee !== null && baseFee !== null && dynamicFee > baseFee ? dynamicFee : baseFee;
  const pair = string(raw?.name)?.includes("-")
    ? raw.name.replaceAll("-", "/")
    : pairLabel(base, quote);
  return {
    dex: "Meteora",
    poolType: "DLMM",
    poolAddress: string(raw?.address),
    programId: null,
    pair,
    baseMint: string(base?.address),
    quoteMint: string(quote?.address),
    baseSymbol: string(base?.symbol),
    quoteSymbol: string(quote?.symbol),
    tvl,
    volume24h,
    lpFee24h,
    feeTier,
    feeMode: dynamicFee !== null && baseFee !== null && dynamicFee > baseFee ? "DYNAMIC" : "BASE",
    apr24h: null,
    officialAprRaw: finite(raw?.apr),
    volumeTvl: tvl !== null && tvl > 0 && volume24h !== null ? volume24h / tvl : null,
    feeTvl,
    currentPrice: finite(raw?.current_price),
    priceMin: null,
    priceMax: null,
    priceVolatilityPct: null,
    activeTimeHours: null,
    activeTimeSource: "官方 DLMM Pool 列表未提供逐小时活跃时长",
    tickSpacing: null,
    currentTick: null,
    binStep: finite(raw?.pool_config?.bin_step),
    isBlacklisted: raw?.is_blacklisted === true,
    tags: Array.isArray(raw?.tags) ? raw.tags : [],
    washVolumeStatus: "NOT_VERIFIED",
    source: "Meteora DLMM API",
    sourceRecord: raw,
    replayEvidence: raw?.replayEvidence ?? null,
  };
}

export function normalizeScannerPools({ raydium = [], meteora = [] } = {}) {
  const rows = [...raydium.map(normalizeRaydiumPool), ...meteora.map(normalizeMeteoraPool)];
  const seen = new Set();
  return rows.filter((row) => {
    if (!row.poolAddress || seen.has(`${row.dex}:${row.poolAddress}`)) return false;
    seen.add(`${row.dex}:${row.poolAddress}`);
    return true;
  });
}

function tagsContain(row, values) {
  const text = row.tags.map((tag) => String(tag).toLowerCase()).join(" ");
  return values.some((value) => text.includes(value));
}

export function evaluateScannerFilter(pool, filters = SCANNER_FILTERS) {
  const reasons = [];
  if (pool.isBlacklisted) reasons.push("BLACKLISTED");
  if (tagsContain(pool, ["dead", "inactive", "scam", "honeypot"])) reasons.push("DEAD_OR_FLAGGED");
  if (pool.tvl === null || pool.tvl <= filters.tvlMin) reasons.push("TVL_BELOW_50K");
  if (pool.volume24h === null || pool.volume24h <= filters.volume24hMin) reasons.push("VOLUME_BELOW_50K");
  if (pool.apr24h !== null && pool.apr24h > filters.maxApr24h) reasons.push("ABNORMAL_APR");
  if (pool.feeTvl !== null && pool.feeTvl > filters.maxFeeTvlRatio24h) reasons.push("ABNORMAL_FEE_TVL");
  return {
    eligible: reasons.length === 0,
    reasons,
    washVolume: pool.washVolumeStatus === "VERIFIED_CLEAN" ? "PASS" : "NOT_VERIFIED",
  };
}

function percentile(value, values, invert = false) {
  if (value === null || values.length < 2) return value === null ? null : 50;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = sorted.findIndex((candidate) => candidate >= value);
  const score = rank < 0 ? 100 : (rank / Math.max(1, sorted.length - 1)) * 100;
  return invert ? 100 - score : score;
}

function marketScore(pool, eligiblePools) {
  const known = (key) => eligiblePools.map((row) => row[key]).filter((value) => value !== null);
  const score = {
    feeEfficiency: percentile(pool.feeTvl, known("feeTvl")),
    capitalUtilization: pool.tvl === null ? null : Math.min(100, Math.log10(Math.max(1, pool.tvl / 1_000)) * 33.33),
    rangeHitRate: null,
    liquiditySafety: percentile(pool.tvl, known("tvl")),
    rebalanceCost: percentile(pool.feeTier, known("feeTier"), true),
  };
  const weights = { feeEfficiency: 0.3, capitalUtilization: 0.25, rangeHitRate: 0.2, liquiditySafety: 0.15, rebalanceCost: 0.1 };
  let total = 0;
  let usedWeight = 0;
  for (const [key, weight] of Object.entries(weights)) {
    if (score[key] === null) continue;
    total += score[key] * weight;
    usedWeight += weight;
  }
  return {
    value: usedWeight > 0 ? Math.round((total / usedWeight) * 10) / 10 : null,
    usedWeight,
    weights,
    score,
    raw: {
      feeEfficiency: pool.feeTvl,
      capitalUtilization: pool.tvl === null ? null : pool.tvl / 1_000,
      rangeHitRate: null,
      liquiditySafety: pool.tvl,
      rebalanceCost: pool.feeTier,
    },
  };
}

function volatilityRegime(pool) {
  if (pool.priceVolatilityPct === null) return "UNKNOWN_VOL";
  if (pool.priceVolatilityPct < 2) return "LOW_VOL";
  if (pool.priceVolatilityPct < 6) return "NORMAL_VOL";
  return "HIGH_VOL";
}

function rangeAround(price, width) {
  if (price === null || price <= 0) return { lower: null, upper: null };
  return { lower: price * (1 - width), upper: price * (1 + width) };
}

function buildRaydiumStrategy(pool, capital = 1_000) {
  const regime = volatilityRegime(pool);
  const preferredCore = regime === "LOW_VOL" ? 0.0025 : regime === "HIGH_VOL" ? 0.01 : 0.005;
  const preferredBuffer = regime === "HIGH_VOL" ? 0.2 : 0.1;
  const searchCandidates = RAYDIUM_CORE_WIDTHS.flatMap((coreWidth) => RAYDIUM_BUFFER_WIDTHS.flatMap((bufferWidth) => RAYDIUM_ALLOCATIONS.map((allocation) => {
    const core = rangeAround(pool.currentPrice, coreWidth);
    const buffer = rangeAround(pool.currentPrice, bufferWidth);
    return {
      id: `core-${coreWidth}-buffer-${bufferWidth}-allocation-${allocation.core}`,
      coreWidth,
      bufferWidth,
      allocation,
      core: { widthPct: coreWidth * 100, lower: core.lower, upper: core.upper, tickLower: null, tickUpper: null, capital: capital * allocation.core },
      buffer: { widthPct: bufferWidth * 100, lower: buffer.lower, upper: buffer.upper, tickLower: null, tickUpper: null, capital: capital * allocation.buffer },
    };
  })));
  const replayChoices = Array.isArray(pool.replayEvidence?.strategyCandidates)
    ? pool.replayEvidence.strategyCandidates.filter((candidate) => ["grossFee24h", "outOfRangeTimeCost", "rebalanceCost", "gasCost", "swapSlippage", "impermanentLoss"].every((key) => finite(candidate?.[key]) !== null))
    : [];
  const replayChoice = replayChoices
    .map((candidate) => searchCandidates.find((option) => option.id === candidate.id))
    .filter(Boolean)
    .sort((left, right) => {
      const net = (candidate) => {
        const replay = replayChoices.find((value) => value.id === candidate.id);
        return replay.grossFee24h - replay.outOfRangeTimeCost - replay.rebalanceCost - replay.gasCost - replay.swapSlippage - replay.impermanentLoss;
      };
      const leftNet = net(left);
      const rightNet = net(right);
      return rightNet - leftNet;
    })[0];
  const selected = replayChoice
    ?? searchCandidates.find((candidate) => candidate.coreWidth === preferredCore && candidate.bufferWidth === preferredBuffer && candidate.allocation.core === 0.7)
    ?? searchCandidates[0];
  return {
    family: "Core + Buffer",
    optimizer: "Raydium CLMM",
    core: selected.core,
    buffer: selected.buffer,
    allocation: `${selected.allocation.core * 100}/${selected.allocation.buffer * 100}`,
    binDistribution: null,
    regime,
    search: {
      candidateCount: searchCandidates.length,
      candidates: searchCandidates.map((candidate) => ({ id: candidate.id, coreWidthPct: candidate.coreWidth * 100, bufferWidthPct: candidate.bufferWidth * 100, allocation: `${candidate.allocation.core * 100}/${candidate.allocation.buffer * 100}` })),
      selectedBy: replayChoice ? "REPLAY_NET_RETURN" : "VOLATILITY_PRIOR_WAITING_REPLAY",
      selectedId: selected.id,
    },
    executionReady: false,
    executionBlocker: pool.tickSpacing === null ? "等待 PoolState tick 对齐" : "等待当前 Tick 与 TickArray",
  };
}

function buildMeteoraStrategy(pool) {
  const regime = volatilityRegime(pool);
  const steps = METEORA_BIN_STEPS[regime] ?? METEORA_BIN_STEPS.UNKNOWN_VOL;
  const binStep = pool.binStep ?? steps[1];
  const mode = regime === "HIGH_VOL" ? "Bid Ask" : regime === "LOW_VOL" ? "Spot" : "Curve";
  const searchCandidates = METEORA_MODES.flatMap((candidateMode) => steps.map((candidateBinStep) => ({ mode: candidateMode, binStep: candidateBinStep })));
  return {
    family: mode,
    optimizer: "Meteora DLMM",
    core: null,
    buffer: null,
    allocation: null,
    binDistribution: { mode, binStep, candidates: steps, searchCandidates },
    regime,
    search: { candidateCount: searchCandidates.length, selectedBy: "VOLATILITY_REGIME" },
    executionReady: false,
    executionBlocker: "等待 Bin path 与逐笔成交回放",
  };
}

function replayForStrategy(pool, strategy) {
  const replay = pool.replayEvidence;
  if (!replay || typeof replay !== "object") return null;
  if (replay.grossFee24h !== undefined) return replay;
  const selected = Array.isArray(replay.strategyCandidates)
    ? replay.strategyCandidates.find((candidate) => candidate?.id === strategy.search?.selectedId)
    : null;
  if (selected) return selected;
  const candidate = Object.values(replay.candidates ?? {}).find((value) => value?.strategyFamily === strategy.family);
  return candidate ?? null;
}

function simulateNetReturn(pool, strategy) {
  const replay = replayForStrategy(pool, strategy);
  const required = ["grossFee24h", "outOfRangeTimeCost", "rebalanceCost", "gasCost", "swapSlippage", "impermanentLoss"];
  if (!replay || !required.every((key) => finite(replay[key]) !== null)) {
    return {
      status: "WAITING_REPLAY",
      grossFee24h: null,
      outOfRangeTimeCost: null,
      rebalanceCost: null,
      gasCost: null,
      swapSlippage: null,
      impermanentLoss: null,
      expectedNetReturn: null,
      rebalanceFrequency: null,
      confidence: null,
    };
  }
  const expectedNetReturn = replay.grossFee24h
    - replay.outOfRangeTimeCost
    - replay.rebalanceCost
    - replay.gasCost
    - replay.swapSlippage
    - replay.impermanentLoss;
  return {
    status: Number.isFinite(expectedNetReturn) ? "COMPLETE" : "WAITING_REPLAY",
    grossFee24h: replay.grossFee24h,
    outOfRangeTimeCost: replay.outOfRangeTimeCost,
    rebalanceCost: replay.rebalanceCost,
    gasCost: replay.gasCost,
    swapSlippage: replay.swapSlippage,
    impermanentLoss: replay.impermanentLoss,
    expectedNetReturn,
    rebalanceFrequency: finite(replay.rebalanceFrequency),
    confidence: finite(replay.confidence),
  };
}

function simulateGrossFee(pool, strategy, capital = 1_000) {
  const poolFee = finite(pool.lpFee24h);
  const tvl = finite(pool.tvl);
  const capitalValue = finite(capital);
  const base = {
    status: "WAITING_MARKET_DATA",
    method: "OFFICIAL_POOL_LP_FEE_PRO_RATA_WITH_SELF_DILUTION",
    capital: capitalValue,
    grossFee24h: null,
    coreGrossFee24h: null,
    bufferGrossFee24h: null,
    capitalShareAfterDeposit: null,
    note: "等待官方 TVL 与 LP Fee；不代表验证净收益",
  };
  if (poolFee === null || tvl === null || capitalValue === null || tvl <= 0 || capitalValue <= 0) return base;

  const capitalShareAfterDeposit = capitalValue / (tvl + capitalValue);
  const grossFee24h = poolFee * capitalShareAfterDeposit;
  const allocation = strategy?.allocation?.split?.("/").map((value) => Number(value) / 100) ?? [];
  const coreShare = Number.isFinite(allocation[0]) ? allocation[0] : null;
  const bufferShare = Number.isFinite(allocation[1]) ? allocation[1] : null;
  return {
    ...base,
    status: Number.isFinite(grossFee24h) ? "SIMULATED" : "WAITING_MARKET_DATA",
    grossFee24h: Number.isFinite(grossFee24h) ? grossFee24h : null,
    coreGrossFee24h: coreShare === null ? null : grossFee24h * coreShare,
    bufferGrossFee24h: bufferShare === null ? null : grossFee24h * bufferShare,
    capitalShareAfterDeposit,
    note: "基于官方池级 LP Fee 与投入后资金占比的毛收益基准；未计区间外、IL、滑点、再平衡或交易成本",
  };
}

function riskFor(pool, netModel, score) {
  if (netModel.status !== "COMPLETE") return "MEDIUM";
  if (pool.feeTvl !== null && pool.feeTvl > 0.1) return "HIGH";
  if (score?.value !== null && score.value >= 70) return "LOW";
  return "MEDIUM";
}

function reasonFor(pool, filter, score, strategy, netModel) {
  const positive = [];
  const negative = [];
  if (pool.feeTvl !== null) positive.push(`Fee/TVL ${(pool.feeTvl * 100).toFixed(2)}%`);
  if (pool.volumeTvl !== null) positive.push(`Volume/TVL ${pool.volumeTvl.toFixed(2)}x`);
  if (pool.tvl !== null && pool.tvl >= 1_000_000) positive.push("流动性安全垫较厚");
  if (pool.priceVolatilityPct === null) negative.push("价格波动率等待历史路径");
  if (pool.washVolumeStatus !== "VERIFIED_CLEAN") negative.push("单笔刷量尚未由逐笔成交验证");
  if (netModel.status !== "COMPLETE") negative.push("等待真实 Replay / IL / 再平衡成本");
  if (filter.washVolume !== "PASS") negative.push("成交活跃时间尚未由逐笔数据证明");
  return { positive, negative, strategy: strategy.family, score: score?.value, filterReasons: filter.reasons };
}

export function buildScannerCandidates(pools, {
  filters = SCANNER_FILTERS,
  capital = 1_000,
  limit = SCANNER_LIMITS.top10,
} = {}) {
  const evaluations = pools.map((pool) => ({ pool, filter: evaluateScannerFilter(pool, filters) }));
  const eligible = evaluations.filter((entry) => entry.filter.eligible).map((entry) => entry.pool);
  const candidates = eligible.map((pool) => {
    const score = marketScore(pool, eligible);
    const strategy = pool.dex === "Raydium" ? buildRaydiumStrategy(pool, capital) : buildMeteoraStrategy(pool);
    const strategySimulation = simulateGrossFee(pool, strategy, capital);
    const netModel = simulateNetReturn(pool, strategy);
    const riskLevel = riskFor(pool, netModel, score);
    const recommendation = netModel.status === "COMPLETE" && netModel.expectedNetReturn > 0 ? "考虑" : "观察";
    return {
      poolAddress: pool.poolAddress,
      pair: pool.pair,
      dex: pool.dex,
      poolType: pool.poolType,
      programId: pool.programId,
      baseMint: pool.baseMint,
      quoteMint: pool.quoteMint,
      tvl: pool.tvl,
      volume24h: pool.volume24h,
      lpFee24h: pool.lpFee24h,
      feeTier: pool.feeTier,
      feeMode: pool.feeMode ?? null,
      volumeTvl: pool.volumeTvl,
      feeTvl: pool.feeTvl,
      priceVolatilityPct: pool.priceVolatilityPct,
      activeTimeHours: pool.activeTimeHours,
      activeTimeSource: pool.activeTimeSource,
      apr24h: pool.apr24h,
      washVolumeStatus: pool.washVolumeStatus,
      strategy,
      strategySimulation,
      netModel,
      expectedNetReturn: netModel.expectedNetReturn,
      riskLevel,
      recommendation,
      lpScore: score.value,
      scoreBreakdown: score,
      filter: evaluations.find((entry) => entry.pool.poolAddress === pool.poolAddress)?.filter ?? null,
      why: reasonFor(pool, evaluations.find((entry) => entry.pool.poolAddress === pool.poolAddress)?.filter ?? { reasons: [], washVolume: "NOT_VERIFIED" }, score, strategy, netModel),
      verification: {
        replay: netModel.status === "COMPLETE" ? "PASS" : "WAITING",
        confidence: netModel.confidence,
        tickPath: strategy.executionReady ? "PASS" : "WAITING",
        markout: netModel.status === "COMPLETE" ? "PASS" : "WAITING",
        il: netModel.impermanentLoss === null ? "WAITING" : "PASS",
      },
      source: pool.source,
      sourceRecord: undefined,
      shadowCapital: capital,
    };
  });

  candidates.sort((left, right) => {
    const netLeft = left.expectedNetReturn;
    const netRight = right.expectedNetReturn;
    if (netLeft !== null && netRight !== null && netLeft !== netRight) return netRight - netLeft;
    if (netLeft !== null && netRight === null) return -1;
    if (netLeft === null && netRight !== null) return 1;
    const grossLeft = left.strategySimulation?.grossFee24h;
    const grossRight = right.strategySimulation?.grossFee24h;
    if (grossLeft !== null && grossRight !== null && grossLeft !== undefined && grossRight !== undefined && grossLeft !== grossRight) {
      return grossRight - grossLeft;
    }
    return (right.lpScore ?? -Infinity) - (left.lpScore ?? -Infinity)
      || (right.feeTvl ?? -Infinity) - (left.feeTvl ?? -Infinity)
      || left.poolAddress.localeCompare(right.poolAddress);
  });
  return {
    allPoolCount: pools.length,
    eligiblePoolCount: eligible.length,
    excludedPoolCount: evaluations.length - eligible.length,
    excludedByReason: evaluations.flatMap((entry) => entry.filter.reasons).reduce((counts, reason) => {
      counts[reason] = (counts[reason] ?? 0) + 1;
      return counts;
    }, {}),
    candidates: candidates.slice(0, limit).map((candidate, index) => ({ ...candidate, rank: index + 1 })),
    rankingBasis: candidates.some((candidate) => candidate.expectedNetReturn !== null)
      ? "EXPECTED_NET_RETURN"
      : candidates.some((candidate) => candidate.strategySimulation?.grossFee24h !== null)
        ? "STRATEGY_SIMULATION_GROSS_PREVIEW_WAITING_REPLAY"
        : "LP_SCORE_MARKET_PREVIEW_WAITING_REPLAY",
  };
}

export async function fetchScannerUniverse({ fetchImpl = fetch, limits = SCANNER_LIMITS } = {}) {
  const results = await Promise.allSettled([
    fetchRaydiumClmmUniverse({ fetchImpl, pageSize: limits.pageSize, maxPages: limits.maxRaydiumPages }),
    fetchMeteoraDlmmUniverse({ fetchImpl, pageSize: limits.pageSize, maxPages: limits.maxMeteoraPages }),
  ]);
  const raydium = results[0].status === "fulfilled" ? results[0].value : { pools: [], pageCount: 0, complete: false, endpoint: RAYDIUM_URL, error: results[0].reason?.message ?? "Raydium 数据源失败" };
  const meteora = results[1].status === "fulfilled" ? results[1].value : { pools: [], pageCount: 0, complete: false, endpoint: METEORA_URL, error: results[1].reason?.message ?? "Meteora 数据源失败" };
  return {
    pools: normalizeScannerPools({ raydium: raydium.pools, meteora: meteora.pools }),
    sources: {
      raydium: { dex: "Raydium", poolType: "CLMM", endpoint: raydium.endpoint, pageCount: raydium.pageCount, poolCount: raydium.pools.length, complete: raydium.complete, error: raydium.error ?? null },
      meteora: { dex: "Meteora", poolType: "DLMM", endpoint: meteora.endpoint, pageCount: meteora.pageCount, poolCount: meteora.pools.length, total: meteora.total ?? null, complete: meteora.complete, error: meteora.error ?? null },
    },
    complete: raydium.complete && meteora.complete,
  };
}

export { normalizeRaydiumPool, normalizeMeteoraPool, volatilityRegime };
