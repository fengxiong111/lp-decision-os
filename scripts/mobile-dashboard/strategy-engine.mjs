import { finite } from "./pool-schema.mjs";

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

export function volatilityRegime(pool) {
  if (pool.priceVolatilityPct === null) return "UNKNOWN_VOL";
  if (pool.priceVolatilityPct < 2) return "LOW_VOL";
  if (pool.priceVolatilityPct < 6) return "NORMAL_VOL";
  return "HIGH_VOL";
}

export function rangeAround(price, width) {
  if (price === null || price <= 0) return { lower: null, upper: null };
  return { lower: price * (1 - width), upper: price * (1 + width) };
}

export function buildRaydiumStrategy(pool, capital = 1_000) {
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
      return net(right) - net(left);
    })[0];
  const selected = replayChoice
    ?? searchCandidates.find((candidate) => candidate.coreWidth === preferredCore && candidate.bufferWidth === preferredBuffer && candidate.allocation.core === 0.7)
    ?? searchCandidates[0];
  return {
    kind: "CORE_BUFFER",
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

export function buildMeteoraStrategy(pool) {
  const regime = volatilityRegime(pool);
  const steps = METEORA_BIN_STEPS[regime] ?? METEORA_BIN_STEPS.UNKNOWN_VOL;
  const binStep = pool.binStep ?? steps[1];
  const mode = regime === "HIGH_VOL" ? "Bid Ask" : regime === "LOW_VOL" ? "Spot" : "Curve";
  const searchCandidates = METEORA_MODES.flatMap((candidateMode) => steps.map((candidateBinStep) => ({ mode: candidateMode, binStep: candidateBinStep })));
  return {
    kind: "DLMM_MODE",
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

export function replayForStrategy(pool, strategy) {
  const replay = pool.replayEvidence;
  if (!replay || typeof replay !== "object") return null;
  if (replay.grossFee24h !== undefined) return replay;
  const selected = Array.isArray(replay.strategyCandidates)
    ? replay.strategyCandidates.find((candidate) => candidate?.id === strategy.search?.selectedId)
    : null;
  if (selected) return selected;
  return Object.values(replay.candidates ?? {}).find((value) => value?.strategyFamily === strategy.family) ?? null;
}

export function simulateGrossFee(pool, strategy, capital = 1_000) {
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

export class StrategyEngine {
  constructor({ capital = 1_000 } = {}) {
    this.capital = capital;
  }

  search(pool) {
    return pool.dex === "Raydium" ? buildRaydiumStrategy(pool, this.capital) : buildMeteoraStrategy(pool);
  }

  simulate(pool, strategy) {
    return simulateGrossFee(pool, strategy, this.capital);
  }

  run(pool) {
    const strategy = this.search(pool);
    return { strategy, simulation: this.simulate(pool, strategy), replay: replayForStrategy(pool, strategy) };
  }
}
