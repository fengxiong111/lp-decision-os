import {
  ADAPTER_LIMITS,
  ADAPTER_SOURCES,
  fetchScannerUniverse as fetchAdaptersUniverse,
  MeteoraAdapter,
  normalizeScannerPools,
  RaydiumAdapter,
} from "./adapters.mjs";
import { decidePool, DECISIONS, DecisionEngine } from "./decision-engine.mjs";
import { evaluateScannerFilter, SCANNER_FILTERS, MarketScanner } from "./market-scanner.mjs";
import { finite } from "./pool-schema.mjs";
import { RiskEngine } from "./risk-engine.mjs";
import { StrategyEngine, volatilityRegime } from "./strategy-engine.mjs";

export const SCANNER_SOURCES = ADAPTER_SOURCES;

export const SCANNER_LIMITS = Object.freeze({
  top10: 10,
  display: 5,
  ...ADAPTER_LIMITS,
});

export const ACTIONS = DECISIONS;

export function evaluateMarketFilter(pool, filters = SCANNER_FILTERS) {
  return new MarketScanner({ filters }).evaluate(pool).filter;
}

function reasonFor(pool, filter, strategy, simulation, risk, decision) {
  const positive = [];
  const negative = [];
  if (pool.feeTvl !== null) positive.push(`Fee/TVL ${(pool.feeTvl * 100).toFixed(2)}%`);
  if (pool.volumeTvl !== null) positive.push(`Volume/TVL ${pool.volumeTvl.toFixed(2)}x`);
  if (pool.tvl !== null && pool.tvl >= 1_000_000) positive.push("流动性安全垫较厚");
  if (simulation.status === "SIMULATED") positive.push("1000U 投入后资金占比已完成毛收益模拟");
  if (pool.priceVolatilityPct === null) negative.push("价格波动率等待历史路径");
  if (pool.washVolumeStatus !== "VERIFIED_CLEAN") negative.push("单笔成交尚未完成逐笔验证");
  if (risk.status !== "COMPLETE") negative.push("等待完整 Replay / IL / 再平衡 / 滑点成本");
  if (filter.washVolume !== "PASS") negative.push("成交质量尚未由逐笔数据证明");
  if (decision.decision === "WATCH") negative.push(decision.reason);
  return { positive, negative, strategy: strategy.family, decision: decision.decision, filterReasons: filter.reasons };
}

function verificationFor(strategy, risk) {
  return {
    replay: risk.status === "COMPLETE" ? "PASS" : "WAITING",
    confidence: risk.confidence,
    tickPath: strategy.executionReady ? "PASS" : "WAITING",
    markout: risk.status === "COMPLETE" ? "PASS" : "WAITING",
    il: risk.impermanentLoss === null ? "WAITING" : "PASS",
  };
}

function compareNullableDesc(left, right) {
  if (left !== null && right !== null && left !== right) return right - left;
  if (left !== null && right === null) return -1;
  if (left === null && right !== null) return 1;
  return 0;
}

function sortCandidates(left, right) {
  const net = compareNullableDesc(left.verifiedNetReturn, right.verifiedNetReturn);
  if (net !== 0) return net;
  const simulated = compareNullableDesc(left.strategySimulation?.grossFee24h ?? null, right.strategySimulation?.grossFee24h ?? null);
  if (simulated !== 0) return simulated;
  const feeDensity = compareNullableDesc(left.feeTvl, right.feeTvl);
  if (feeDensity !== 0) return feeDensity;
  const velocity = compareNullableDesc(left.volumeTvl, right.volumeTvl);
  if (velocity !== 0) return velocity;
  return compareNullableDesc(left.tvl, right.tvl) || left.poolAddress.localeCompare(right.poolAddress);
}

export function buildScannerCandidates(pools, {
  filters = SCANNER_FILTERS,
  capital = 1_000,
  limit = SCANNER_LIMITS.top10,
} = {}) {
  const marketScanner = new MarketScanner({ filters });
  const market = marketScanner.discover(pools);
  const strategyEngine = new StrategyEngine({ capital });
  const riskEngine = new RiskEngine();
  const decisionEngine = new DecisionEngine();
  const candidates = market.eligible.map(({ pool, filter, market: marketEvidence }) => {
    const strategyRun = strategyEngine.run(pool);
    const risk = riskEngine.evaluate(pool, strategyRun.strategy);
    const decision = decisionEngine.decide({ strategy: strategyRun.strategy, simulation: strategyRun.simulation, risk });
    return {
      poolSchemaVersion: pool.schemaVersion,
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
      feeMode: pool.feeMode,
      feeApr24h: pool.feeApr24h,
      apr24h: pool.apr24h,
      volumeTvl: pool.volumeTvl,
      feeTvl: pool.feeTvl,
      currentPrice: pool.currentPrice,
      priceVolatilityPct: pool.priceVolatilityPct,
      activeTimeHours: pool.activeTimeHours,
      activeTimeSource: pool.activeTimeSource,
      washVolumeStatus: pool.washVolumeStatus,
      market: marketEvidence,
      strategy: strategyRun.strategy,
      strategySimulation: strategyRun.simulation,
      riskModel: risk,
      riskLevel: risk.riskLevel,
      verifiedNetReturn: risk.expectedNetReturn,
      decision: decision.decision,
      decisionReasonCode: decision.reasonCode,
      decisionReason: decision.reason,
      filter,
      why: reasonFor(pool, filter, strategyRun.strategy, strategyRun.simulation, risk, decision),
      verification: verificationFor(strategyRun.strategy, risk),
      source: pool.source,
      sourceRecord: undefined,
      shadowCapital: capital,
    };
  });

  candidates.sort(sortCandidates);
  const rankingBasis = candidates.some((candidate) => candidate.verifiedNetReturn !== null)
    ? "VERIFIED_NET_RETURN"
    : candidates.some((candidate) => candidate.strategySimulation?.grossFee24h !== null)
      ? "STRATEGY_SIMULATION_GROSS_PREVIEW"
      : "MARKET_RADAR_PREVIEW";
  return {
    allPoolCount: market.allPoolCount,
    eligiblePoolCount: market.eligiblePoolCount,
    excludedPoolCount: market.excludedPoolCount,
    excludedByReason: market.excludedByReason,
    candidates: candidates.slice(0, limit).map((candidate, index) => ({ ...candidate, rank: index + 1 })),
    rankingBasis,
  };
}

export async function fetchScannerUniverse(options = {}) {
  return fetchAdaptersUniverse(options);
}

export async function fetchRaydiumClmmUniverse(options = {}) {
  return new RaydiumAdapter(options).discover();
}

export async function fetchMeteoraDlmmUniverse(options = {}) {
  return new MeteoraAdapter(options).discover();
}

export function normalizeRaydiumPool(raw) {
  return new RaydiumAdapter().normalize(raw);
}

export function normalizeMeteoraPool(raw) {
  return new MeteoraAdapter().normalize(raw);
}

export { SCANNER_FILTERS, evaluateScannerFilter, normalizeScannerPools, volatilityRegime, finite, decidePool };
