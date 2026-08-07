import type { EventWindowCoverage, ResearchUniverse } from "@/packages/models/src";
import type { RaydiumPoolInfo } from "@/services/raydium/api";
import { RAYDIUM_PROGRAM_IDS, USDC_MINT } from "@/services/raydium/config";
import { coverageIsDeterministicallyComplete } from "@/services/indexer/progress";
import { PARSER_RECOVERY_TARGETS, selectParserRecoveryPools } from "@/services/indexer/parser-recovery";
import { getHttpMetricsSnapshot, type HttpMetricsSnapshot } from "@/services/shared/http";
import { persistIndexerState, persistNormalizedSwaps, persistRpcTransactionCache, persistTransactionClassifications, readIndexerState, readParserFunnel, readRpcTransactionCache, readWindowCoverage, type CachedRpcTransaction } from "@/services/storage/event-index";
import { readMarketProjection } from "@/services/projection/market";
import { fetchPoolKeys } from "@/services/raydium/keys";
import { reconcilePools } from "@/services/reconciler";
import { getActiveRpcProvider, getRpcPoolSnapshot, parseProgramTransaction, rpcBatchRequest, rpcRequest, type HistoricalTransaction, type ProgramBackfillPool, type RpcProvider } from "@/services/rpc/pool";

export const UNIVERSE_EXPANSION_STATE_KEY = "universe.expansion";
export const EXPANSION_MAX_TIER1_POOLS = 5;
export const EXPANSION_GATE_PARSER_MIN = 99;
export const EXPANSION_GATE_FEE_RECONCILIATION_MIN = 99;
export const EXPANSION_GATE_RPC_429_MAX = 5;
export const EXPANSION_GATE_UNKNOWN_INSTRUCTION_MAX = 0.5;
export const REALTIME_LATENCY_MAX_SECONDS = 15;

export type ExpansionStage = "STAGE_A" | "STAGE_B";
export type AdmissionPhase =
  | "BASELINE_READY"
  | "IDENTITY_PENDING"
  | "PROGRAM_PENDING"
  | "FEE_CONFIG_PENDING"
  | "FIXTURE_PENDING"
  | "PARSER_PENDING"
  | "FEE_RECONCILIATION_PENDING"
  | "WINDOW_1H_PENDING"
  | "WINDOW_6H_PENDING"
  | "WINDOW_12H_PENDING"
  | "READY"
  | "TIER2_OFFICIAL_ONLY"
  | "QUARANTINED";

export type WindowAdmissionState = {
  "1h": boolean;
  "6h": boolean;
  "12h": boolean;
};

export type PoolAdmission = {
  poolId: string;
  symbol: string;
  tier: "BASELINE" | 1 | 2;
  phase: AdmissionPhase;
  identityValid: boolean | null;
  programValid: boolean | null;
  feeConfigValid: boolean | null;
  fixtureCount: number;
  fixtureCandidateCount: number;
  fixtureParsedCount: number;
  fixtureUnsupportedCount: number;
  fixtureAmountFailureCount: number;
  parserSuccessRate: number | null;
  feeReconciliationPassRate: number | null;
  windows: WindowAdmissionState;
  formalRanking: boolean;
  blockers: string[];
  lastCheckedAt: string;
};

export type StageAGates = {
  parserSuccessRateByPool: Record<string, number | null>;
  parserSuccessPassed: boolean;
  feeReconciliationPassRate: number | null;
  feeReconciliationPassed: boolean;
  windows: Record<string, WindowAdmissionState>;
  windowsPassed: boolean;
  rpc429RateLast30m: number | null;
  rpc429Passed: boolean;
  realtimeLatencySeconds: number | null;
  realtimeLatencyPassed: boolean;
  websocketGapCount: number | null;
  websocketGapPassed: boolean;
  projectionVersion: number | null;
  previousProjectionVersion: number | null;
  projectionVersionIncreasing: boolean;
  cursorResumeVerified: boolean;
  rankingAutoUpdateVerified: boolean;
  capitalSizingVerified: boolean;
  passed: boolean;
  blockers: string[];
  checkedAt: string;
};

export type UniverseExpansionState = {
  schemaVersion: 1;
  generatedAt: string;
  stage: ExpansionStage;
  stablePoolIds: string[];
  eligiblePoolIds: string[];
  tier1PoolIds: string[];
  tier2PoolIds: string[];
  activeShortWindowPoolIds: string[];
  formalRankingPoolIds: string[];
  admission: Record<string, PoolAdmission>;
  gates: StageAGates;
  UNIVERSE_5_READY: boolean;
  TVL_FILTERED_UNIVERSE_READY: boolean;
  rollbackReason: string | null;
  policy: {
    tier1: "top5_by_24h_volume_plus_baseline";
    tier2: "official_24h_plus_low_frequency_realtime";
    historicalBackfill: "tier1_only_until_stable";
    maxHighFrequencyPools: number;
  };
};

type GateOverrides = Partial<StageAGates>;

const FIXTURE_CANDIDATE_CATEGORIES = new Set([
  "PARSED_SWAP",
  "AMOUNT_RECONCILIATION_FAILED",
  "TOKEN_BALANCE_MISSING",
  "TOKEN_DECIMALS_MISSING",
  "FEE_CONFIG_MISSING",
  "FEE_VERSION_UNSUPPORTED",
  "PROGRAM_UNSUPPORTED",
  "INSTRUCTION_DISCRIMINATOR_UNKNOWN",
  "INNER_INSTRUCTIONS_MISSING",
  "ACCOUNT_INDEX_INVALID",
  "PARSE_EXCEPTION",
]);

function assetSymbol(pool: RaydiumPoolInfo): string {
  return pool.mintA.address === USDC_MINT ? pool.mintB.symbol : pool.mintA.symbol;
}

function volumeRank(pool: RaydiumPoolInfo): number {
  return pool.day.volume ?? pool.day.volumeFee ?? -Infinity;
}

function identityValid(pool: RaydiumPoolInfo): boolean {
  return pool.pooltype.includes("RWA")
    && ((pool.mintA.address === USDC_MINT && pool.mintB.address !== USDC_MINT)
      || (pool.mintB.address === USDC_MINT && pool.mintA.address !== USDC_MINT))
    && RAYDIUM_PROGRAM_IDS.has(pool.programId)
    && pool.identityConflict === null
    && pool.kind !== null;
}

function eligibleForExpansion(pool: RaydiumPoolInfo, universe: ResearchUniverse): boolean {
  return universe.activePoolIds.includes(pool.id)
    && identityValid(pool)
    && pool.isActive !== false
    && pool.tvl !== null
    && pool.tvl >= 5_000;
}

export function selectExpansionCandidates(pools: RaydiumPoolInfo[], universe: ResearchUniverse): {
  eligible: RaydiumPoolInfo[];
  tier1: RaydiumPoolInfo[];
  tier2: RaydiumPoolInfo[];
} {
  const eligible = pools.filter((pool) => eligibleForExpansion(pool, universe));
  const ranked = [...eligible].sort((left, right) => volumeRank(right) - volumeRank(left));
  const tier1 = ranked.slice(0, EXPANSION_MAX_TIER1_POOLS);
  const tier1Ids = new Set(tier1.map((pool) => pool.id));
  const baselineIds = new Set(selectParserRecoveryPools(pools).map((pool) => pool.id));
  // Baseline pools are never demoted to Tier2 even if their 24h volume falls
  // outside the top-five expansion slice.
  const tier2 = ranked.filter((pool) => !tier1Ids.has(pool.id) && !baselineIds.has(pool.id));
  return { eligible, tier1, tier2 };
}

function emptyWindows(): WindowAdmissionState {
  return { "1h": false, "6h": false, "12h": false };
}

function windowEvidence(poolId: string, coverage: Record<string, Record<string, EventWindowCoverage>>): WindowAdmissionState {
  const rows = coverage[poolId] ?? {};
  return {
    "1h": coverageIsDeterministicallyComplete(rows["1h"], "1h"),
    "6h": coverageIsDeterministicallyComplete(rows["6h"], "6h"),
    "12h": coverageIsDeterministicallyComplete(rows["12h"], "12h"),
  };
}

function feeReconciliationRates(poolIds: string[]): { overall: number | null; byPool: Record<string, number | null> } {
  const explicit = readIndexerState<{ passRate?: number | null; byPool?: Record<string, number | null> }>("fee.reconciliation");
  const projection = readMarketProjection();
  const snapshotPools = projection?.snapshot?.pools ?? [];
  const byPool: Record<string, number | null> = {};
  for (const poolId of poolIds) {
    const explicitRate = explicit?.byPool?.[poolId];
    if (typeof explicitRate === "number") {
      byPool[poolId] = explicitRate;
      continue;
    }
    const snapshot = snapshotPools.find((pool) => pool.id === poolId);
    byPool[poolId] = snapshot?.feeReconciliation.status === "PASS" ? 100 : snapshot?.feeReconciliation.status === "FAILED" ? 0 : null;
  }
  const explicitOverall = explicit?.passRate;
  if (typeof explicitOverall === "number") return { overall: explicitOverall, byPool };
  const known = Object.values(byPool).filter((value): value is number => typeof value === "number");
  return { overall: known.length === poolIds.length && poolIds.length > 0 ? known.reduce((sum, value) => sum + value, 0) / known.length : null, byPool };
}

function rpcMetrics(): Partial<HttpMetricsSnapshot> {
  return readIndexerState<Partial<HttpMetricsSnapshot>>("rpc.metrics.backfill")
    ?? readIndexerState<Partial<HttpMetricsSnapshot>>("rpc.metrics")
    ?? getHttpMetricsSnapshot();
}

function lastRealtimeAt(): string | null {
  const stream = readIndexerState<{ lastEventAt?: string | null }>("stream.status");
  const event = readIndexerState<{ checkedAt?: string }>("stream.last_event");
  const received = readIndexerState<{ receivedAt?: string }>("stream.last_event_received");
  return stream?.lastEventAt ?? event?.checkedAt ?? received?.receivedAt ?? null;
}

function projectionGates(previous: UniverseExpansionState | null, now: Date): Pick<StageAGates, "projectionVersion" | "previousProjectionVersion" | "projectionVersionIncreasing" | "rankingAutoUpdateVerified" | "capitalSizingVerified"> {
  const projection = readMarketProjection();
  const currentVersion = projection?.projectionVersion ?? null;
  const previousVersion = previous?.gates.projectionVersion ?? null;
  const increasing = currentVersion !== null && previousVersion !== null && currentVersion > previousVersion;
  const hasRankings = Boolean(projection?.rankings?.["1000"] && projection?.rankings?.["10000"]);
  const capitalSizing = Boolean(projection?.snapshot?.pools?.length && projection.snapshot.pools.some((pool) => {
    const oneK = pool.executableEstimates?.["1000"]?.["1h"];
    const tenK = pool.executableEstimates?.["10000"]?.["1h"];
    return oneK?.capitalUsd === 1_000 && tenK?.capitalUsd === 10_000;
  }));
  // now is intentionally part of the evidence contract: it prevents a stale
  // projection from being counted as an auto-updating page even if its shape is valid.
  const fresh = projection ? Date.parse(projection.receivedAt) >= now.getTime() - 2 * 60_000 : false;
  return {
    projectionVersion: currentVersion,
    previousProjectionVersion: previousVersion,
    projectionVersionIncreasing: increasing,
    rankingAutoUpdateVerified: hasRankings && fresh && increasing,
    capitalSizingVerified: capitalSizing,
  };
}

export function buildStageAGates(pools: RaydiumPoolInfo[], now = new Date(), overrides: GateOverrides = {}): StageAGates {
  const stableExpected = PARSER_RECOVERY_TARGETS.map((target) => target.poolId);
  const stable = selectParserRecoveryPools(pools);
  const stableIds = stable.map((pool) => pool.id);
  const parserSuccessRateByPool: Record<string, number | null> = Object.fromEntries(stableExpected.map((poolId) => {
    const funnel = readParserFunnel(poolId);
    return [poolId, funnel.raydiumSwapCandidate > 0 ? funnel.realParseSuccessRate : null];
  }));
  const parserSuccessPassed = stableExpected.every((poolId) => (parserSuccessRateByPool[poolId] ?? -1) >= EXPANSION_GATE_PARSER_MIN);
  const fee = feeReconciliationRates(stableExpected);
  const coverage = readWindowCoverage(stableIds);
  const windows = Object.fromEntries(stableExpected.map((poolId) => [poolId, windowEvidence(poolId, coverage)]));
  const windowsPassed = stableExpected.length === stableIds.length && stableIds.every((poolId) => Object.values(windows[poolId] ?? emptyWindows()).every(Boolean));
  const metrics = rpcMetrics();
  const last30 = metrics.rpcFailureStats?.last30m;
  const rpc429RateLast30m = last30 && last30.requests > 0 ? (last30.rateLimit429 / last30.requests) * 100 : null;
  const rpc429Passed = rpc429RateLast30m !== null && rpc429RateLast30m <= EXPANSION_GATE_RPC_429_MAX;
  const realtime = lastRealtimeAt();
  const realtimeLatencySeconds = realtime ? Math.max(0, (now.getTime() - Date.parse(realtime)) / 1_000) : null;
  const stream = readIndexerState<{ status?: string; gapCount?: number; gapSlots?: number }>("stream.status");
  const websocketGapCount = stream ? (stream.gapCount ?? 0) + (stream.gapSlots ?? 0) : null;
  const realtimeLatencyPassed = realtimeLatencySeconds !== null && Number.isFinite(realtimeLatencySeconds) && realtimeLatencySeconds <= REALTIME_LATENCY_MAX_SECONDS;
  const websocketGapPassed = stream?.status === "CONNECTED" && websocketGapCount === 0;
  const resume = readIndexerState<{ verified?: boolean; cursorRegression?: boolean }>("backfill.resume");
  const projection = projectionGates(readUniverseExpansionState(), now);
  const gate: StageAGates = {
    parserSuccessRateByPool: overrides.parserSuccessRateByPool ?? parserSuccessRateByPool,
    parserSuccessPassed: overrides.parserSuccessPassed ?? parserSuccessPassed,
    feeReconciliationPassRate: overrides.feeReconciliationPassRate ?? fee.overall,
    feeReconciliationPassed: overrides.feeReconciliationPassed ?? (fee.overall !== null && fee.overall >= EXPANSION_GATE_FEE_RECONCILIATION_MIN),
    windows: overrides.windows ?? windows,
    windowsPassed: overrides.windowsPassed ?? windowsPassed,
    rpc429RateLast30m: overrides.rpc429RateLast30m ?? rpc429RateLast30m,
    rpc429Passed: overrides.rpc429Passed ?? rpc429Passed,
    realtimeLatencySeconds: overrides.realtimeLatencySeconds ?? realtimeLatencySeconds,
    realtimeLatencyPassed: overrides.realtimeLatencyPassed ?? realtimeLatencyPassed,
    websocketGapCount: overrides.websocketGapCount ?? websocketGapCount,
    websocketGapPassed: overrides.websocketGapPassed ?? websocketGapPassed,
    ...projection,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => ["projectionVersion", "previousProjectionVersion", "projectionVersionIncreasing", "rankingAutoUpdateVerified", "capitalSizingVerified"].includes(key))) as Pick<StageAGates, "projectionVersion" | "previousProjectionVersion" | "projectionVersionIncreasing" | "rankingAutoUpdateVerified" | "capitalSizingVerified">,
    cursorResumeVerified: overrides.cursorResumeVerified ?? (resume?.verified === true && resume.cursorRegression !== true),
    rankingAutoUpdateVerified: overrides.rankingAutoUpdateVerified ?? projection.rankingAutoUpdateVerified,
    capitalSizingVerified: overrides.capitalSizingVerified ?? projection.capitalSizingVerified,
    passed: false,
    blockers: [],
    checkedAt: now.toISOString(),
  };
  const checks: Array<[keyof StageAGates, string]> = [
    ["parserSuccessPassed", "阶段A Parser 成功率未达到99%"],
    ["feeReconciliationPassed", "阶段A Fee 双路线对账尚无99% PASS证据"],
    ["windowsPassed", "阶段A 1h/6h/12h 尚未全部 COMPLETE"],
    ["rpc429Passed", "最近30分钟 RPC 429 率未达到 <=5%"],
    ["realtimeLatencyPassed", "实时事件延迟无法证明 <=15秒"],
    ["websocketGapPassed", "WebSocket 尚未 CONNECTED 或存在 gap"],
    ["projectionVersionIncreasing", "projectionVersion 尚未连续递增"],
    ["cursorResumeVerified", "重启后游标续传尚无证据"],
    ["rankingAutoUpdateVerified", "排名自动更新尚无连续 projection 证据"],
    ["capitalSizingVerified", "$1,000 与 $10,000 尚未同时生成"],
  ];
  gate.blockers = checks.filter(([key]) => gate[key] !== true).map(([, reason]) => reason);
  gate.passed = gate.blockers.length === 0;
  return gate;
}

function previousAdmission(previous: UniverseExpansionState | null, poolId: string): PoolAdmission | null {
  return previous?.admission?.[poolId] ?? null;
}

function phaseForAdmission(input: {
  identity: boolean;
  program: boolean;
  feeConfig: boolean;
  fixtureCount: number;
  parserRate: number | null;
  feeReconRate: number | null;
  fixtureUnsupportedCount: number;
  windows: WindowAdmissionState;
}): { phase: AdmissionPhase; blockers: string[] } {
  const blockers: string[] = [];
  if (!input.identity) return { phase: "QUARANTINED", blockers: ["RWA/USDC、Mint、身份或可交易性核验失败"] };
  if (!input.program) return { phase: "PROGRAM_PENDING", blockers: ["Program ID 或 Pool kind 尚未通过核验"] };
  if (!input.feeConfig) return { phase: "FEE_CONFIG_PENDING", blockers: ["Fee Tier / Pool Config 尚未读取"] };
  if (input.fixtureCount < 20) return { phase: "FIXTURE_PENDING", blockers: [`真实 Swap fixture ${input.fixtureCount}/20`] };
  const unknownRate = (input.fixtureUnsupportedCount / input.fixtureCount) * 100;
  if (unknownRate > EXPANSION_GATE_UNKNOWN_INSTRUCTION_MAX) return { phase: "PARSER_PENDING", blockers: [`未知/不支持指令 ${unknownRate.toFixed(2)}%，超过 ${EXPANSION_GATE_UNKNOWN_INSTRUCTION_MAX}% 门槛`] };
  if (input.parserRate === null || input.parserRate < EXPANSION_GATE_PARSER_MIN) return { phase: "PARSER_PENDING", blockers: [`fixture Parser 成功率 ${input.parserRate === null ? "暂无" : `${input.parserRate.toFixed(2)}%`}，门槛99%`] };
  if (input.feeReconRate === null || input.feeReconRate < EXPANSION_GATE_FEE_RECONCILIATION_MIN) return { phase: "FEE_RECONCILIATION_PENDING", blockers: [`Fee 对账通过率 ${input.feeReconRate === null ? "暂无" : `${input.feeReconRate.toFixed(2)}%`}，门槛99%`] };
  if (!input.windows["1h"]) return { phase: "WINDOW_1H_PENDING", blockers: ["1h 尚未 deterministic COMPLETE"] };
  if (!input.windows["6h"]) return { phase: "WINDOW_6H_PENDING", blockers: ["6h 尚未 deterministic COMPLETE"] };
  if (!input.windows["12h"]) return { phase: "WINDOW_12H_PENDING", blockers: ["12h 尚未 deterministic COMPLETE"] };
  return { phase: "READY", blockers };
}

function admissionFor(
  pool: RaydiumPoolInfo,
  tier: "BASELINE" | 1 | 2,
  previous: PoolAdmission | null,
  coverage: Record<string, Record<string, EventWindowCoverage>>,
  feeRates: Record<string, number | null>,
  now: Date,
): PoolAdmission {
  const identity = identityValid(pool) && pool.isActive !== false;
  const program = RAYDIUM_PROGRAM_IDS.has(pool.programId) && pool.kind !== null;
  const feeConfig = pool.feeRate !== null && (pool.config?.tradeFeeRate ?? pool.feeRate) !== null;
  const funnel = readParserFunnel(pool.id);
  const parserRate = funnel.raydiumSwapCandidate > 0 ? funnel.realParseSuccessRate : previous?.parserSuccessRate ?? null;
  const fixtureCount = previous?.fixtureCount ?? 0;
  const fixtureCandidateCount = previous?.fixtureCandidateCount ?? 0;
  const fixtureParsedCount = previous?.fixtureParsedCount ?? 0;
  const fixtureUnsupportedCount = previous?.fixtureUnsupportedCount ?? 0;
  const fixtureAmountFailureCount = previous?.fixtureAmountFailureCount ?? 0;
  const windows = windowEvidence(pool.id, coverage);
  const feeReconRate = feeRates[pool.id] ?? previous?.feeReconciliationPassRate ?? null;
  if (tier === 2) {
    return {
      poolId: pool.id,
      symbol: assetSymbol(pool),
      tier,
      phase: "TIER2_OFFICIAL_ONLY",
      identityValid: identity,
      programValid: program,
      feeConfigValid: feeConfig,
      fixtureCount,
      fixtureCandidateCount,
      fixtureParsedCount,
      fixtureUnsupportedCount,
      fixtureAmountFailureCount,
      parserSuccessRate: parserRate,
      feeReconciliationPassRate: feeReconRate,
      windows,
      formalRanking: false,
      blockers: ["Tier2 保留官方24h；待Tier1与RPC健康稳定后再进入历史回补"],
      lastCheckedAt: now.toISOString(),
    };
  }
  const result = tier === "BASELINE"
    ? { phase: "BASELINE_READY" as const, blockers: [] }
    : phaseForAdmission({ identity, program, feeConfig, fixtureCount, parserRate, feeReconRate, fixtureUnsupportedCount, windows });
  return {
    poolId: pool.id,
    symbol: assetSymbol(pool),
    tier,
    phase: result.phase,
    identityValid: identity,
    programValid: program,
    feeConfigValid: feeConfig,
    fixtureCount,
    fixtureCandidateCount,
    fixtureParsedCount,
    fixtureUnsupportedCount,
    fixtureAmountFailureCount,
    parserSuccessRate: parserRate,
    feeReconciliationPassRate: feeReconRate,
    windows,
    formalRanking: result.phase === "READY" || result.phase === "BASELINE_READY",
    blockers: result.blockers,
    lastCheckedAt: now.toISOString(),
  };
}

export function readUniverseExpansionState(): UniverseExpansionState | null {
  const state = readIndexerState<UniverseExpansionState>(UNIVERSE_EXPANSION_STATE_KEY);
  if (!state || state.schemaVersion !== 1 || !state.gates || !state.admission) return null;
  return state;
}

export function persistUniverseExpansionState(state: UniverseExpansionState): UniverseExpansionState {
  persistIndexerState(UNIVERSE_EXPANSION_STATE_KEY, state);
  return state;
}

export function evaluateUniverseExpansion(
  pools: RaydiumPoolInfo[],
  universe: ResearchUniverse,
  now = new Date(),
  options: { previous?: UniverseExpansionState | null; persist?: boolean; gates?: GateOverrides } = {},
): UniverseExpansionState {
  const previous = options.previous === undefined ? readUniverseExpansionState() : options.previous;
  const gates = buildStageAGates(pools, now, options.gates ?? {});
  const candidates = selectExpansionCandidates(pools, universe);
  const stablePools = selectParserRecoveryPools(pools);
  const stableIds = stablePools.map((pool) => pool.id);
  const coverage = readWindowCoverage([...new Set([...stableIds, ...candidates.eligible.map((pool) => pool.id)])]);
  const feeRates = feeReconciliationRates([...new Set([...stableIds, ...candidates.eligible.map((pool) => pool.id)])]).byPool;
  const gateStage: ExpansionStage = gates.passed ? "STAGE_B" : "STAGE_A";
  const admission: Record<string, PoolAdmission> = {};
  for (const pool of stablePools) admission[pool.id] = admissionFor(pool, "BASELINE", previousAdmission(previous, pool.id), coverage, feeRates, now);
  for (const pool of candidates.tier1) {
    if (stableIds.includes(pool.id)) continue;
    admission[pool.id] = admissionFor(pool, 1, previousAdmission(previous, pool.id), coverage, feeRates, now);
  }
  for (const pool of candidates.tier2) admission[pool.id] = admissionFor(pool, 2, previousAdmission(previous, pool.id), coverage, feeRates, now);
  const parserFailure = gateStage === "STAGE_B"
    ? candidates.tier1.find((pool) => {
      const item = admission[pool.id];
      return item && item.fixtureCount >= 20 && (item.phase === "PARSER_PENDING" || (unknownInstructionRate(item) ?? 0) > EXPANSION_GATE_UNKNOWN_INSTRUCTION_MAX);
    })
    : undefined;
  const stage: ExpansionStage = parserFailure ? "STAGE_A" : gateStage;
  const admittedWindowPoolIds = candidates.tier1.filter((pool) => {
    const phase = admission[pool.id]?.phase;
    return phase === "WINDOW_1H_PENDING" || phase === "WINDOW_6H_PENDING" || phase === "WINDOW_12H_PENDING" || phase === "READY";
  }).map((pool) => pool.id);
  const activeShortWindowPoolIds = [...new Set([...stableIds, ...(stage === "STAGE_B" ? admittedWindowPoolIds : [])])];
  const formalRankingPoolIds = [...new Set([...stableIds, ...(stage === "STAGE_B" ? candidates.tier1.filter((pool) => admission[pool.id]?.formalRanking).map((pool) => pool.id) : [])])];
  const topTier1Ready = stage === "STAGE_B" && candidates.tier1.length === EXPANSION_MAX_TIER1_POOLS && candidates.tier1.every((pool) => admission[pool.id]?.phase === "READY");
  const allEligibleReady = stage === "STAGE_B" && candidates.eligible.length > 0 && candidates.eligible.every((pool) => {
    const record = admission[pool.id];
    return record?.phase === "READY";
  });
  const state: UniverseExpansionState = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    stage,
    stablePoolIds: stableIds,
    eligiblePoolIds: candidates.eligible.map((pool) => pool.id),
    tier1PoolIds: candidates.tier1.map((pool) => pool.id),
    tier2PoolIds: candidates.tier2.map((pool) => pool.id),
    activeShortWindowPoolIds,
    formalRankingPoolIds,
    admission,
    gates,
    UNIVERSE_5_READY: topTier1Ready,
    TVL_FILTERED_UNIVERSE_READY: allEligibleReady,
    rollbackReason: stage === "STAGE_A"
      ? parserFailure
        ? `${assetSymbol(parserFailure)} fixture Parser/未知指令闸门失败，已回退上一稳定Universe`
        : gates.blockers[0] ?? "阶段A闸门未通过"
      : null,
    policy: {
      tier1: "top5_by_24h_volume_plus_baseline",
      tier2: "official_24h_plus_low_frequency_realtime",
      historicalBackfill: "tier1_only_until_stable",
      maxHighFrequencyPools: EXPANSION_MAX_TIER1_POOLS,
    },
  };
  return options.persist === false ? state : persistUniverseExpansionState(state);
}

export function selectShortWindowPools(pools: RaydiumPoolInfo[], state = readUniverseExpansionState()): RaydiumPoolInfo[] {
  if (!state || state.stage === "STAGE_A") return selectParserRecoveryPools(pools);
  const ids = new Set(state.activeShortWindowPoolIds);
  const selected = pools.filter((pool) => ids.has(pool.id));
  return selected.length > 0 ? selected : selectParserRecoveryPools(pools);
}

export function selectFormalRankingPoolIds(state = readUniverseExpansionState()): string[] {
  return state?.formalRankingPoolIds ?? [];
}

export function selectTier2PoolIds(state = readUniverseExpansionState()): string[] {
  return state?.stage === "STAGE_B" ? state.tier2PoolIds : [];
}

export type FixtureEvidence = {
  fixtureCount: number;
  fixtureCandidateCount: number;
  fixtureParsedCount: number;
  fixtureUnsupportedCount: number;
  fixtureAmountFailureCount: number;
  parserSuccessRate: number | null;
  checkedAt: string;
  source: "rpc_fixture_20";
  error: string | null;
};

export function recordFixtureEvidence(state: UniverseExpansionState, poolId: string, evidence: FixtureEvidence): UniverseExpansionState {
  const prior = state.admission[poolId];
  if (!prior) return state;
  const nextAdmission: PoolAdmission = {
    ...prior,
    fixtureCount: evidence.fixtureCount,
    fixtureCandidateCount: evidence.fixtureCandidateCount,
    fixtureParsedCount: evidence.fixtureParsedCount,
    fixtureUnsupportedCount: evidence.fixtureUnsupportedCount,
    fixtureAmountFailureCount: evidence.fixtureAmountFailureCount,
    parserSuccessRate: evidence.parserSuccessRate,
    blockers: evidence.error ? [evidence.error] : prior.blockers,
    lastCheckedAt: evidence.checkedAt,
  };
  return persistUniverseExpansionState({ ...state, generatedAt: evidence.checkedAt, admission: { ...state.admission, [poolId]: nextAdmission } });
}

function admissionProgramPool(pool: RaydiumPoolInfo, keys: Map<string, { vaultA: string | null; vaultB: string | null }>): ProgramBackfillPool {
  const assetIsA = pool.mintA.address !== USDC_MINT;
  const asset = assetIsA ? pool.mintA : pool.mintB;
  const quote = assetIsA ? pool.mintB : pool.mintA;
  const key = keys.get(pool.id);
  return {
    id: pool.id,
    programId: pool.programId,
    poolKind: pool.kind,
    vaultA: key?.vaultA ?? null,
    vaultB: key?.vaultB ?? null,
    assetMint: asset.address,
    quoteMint: quote.address,
    currentPrice: pool.price === null ? null : assetIsA ? pool.price : pool.price > 0 ? 1 / pool.price : null,
    feeRate: pool.feeRate,
    hasDynamicFee: pool.hasDynamicFee === true,
  };
}

type FixtureSignature = { signature: string; slot: number | null; blockTime: number | null; err: boolean };

/**
 * Tier1 onboarding deliberately handles one Pool and at most twenty cached
 * transactions per cycle. It is a fixture gate, not a shortcut into the
 * formal ranking and never fans out getTransaction across the full universe.
 */
export async function runPoolAdmissionFixtureCycle(input: {
  pools: RaydiumPoolInfo[];
  state: UniverseExpansionState | null;
  provider?: RpcProvider | null;
  now?: Date;
}): Promise<{ poolId: string | null; evidence: FixtureEvidence | null; detail: string }> {
  const now = input.now ?? new Date();
  const state = input.state ?? readUniverseExpansionState();
  if (!state || state.stage !== "STAGE_B") return { poolId: null, evidence: null, detail: "阶段A闸门未通过，未启动新增Pool fixture" };
  const candidate = state.tier1PoolIds
    .map((poolId) => state.admission[poolId])
    .find((admission) => admission && admission.phase === "FIXTURE_PENDING");
  if (!candidate) return { poolId: null, evidence: null, detail: "Tier1 当前没有处于 FIXTURE_PENDING 的新增Pool" };
  const pool = input.pools.find((item) => item.id === candidate.poolId);
  if (!pool) return { poolId: candidate.poolId, evidence: null, detail: "候选Pool已不在当前公开发现结果，保持上一稳定Universe" };
  const provider = input.provider ?? getActiveRpcProvider(await getRpcPoolSnapshot());
  if (!provider) {
    const evidence: FixtureEvidence = { fixtureCount: 0, fixtureCandidateCount: 0, fixtureParsedCount: 0, fixtureUnsupportedCount: 0, fixtureAmountFailureCount: 0, parserSuccessRate: null, checkedAt: now.toISOString(), source: "rpc_fixture_20", error: "没有可用 RPC，fixture 未启动" };
    recordFixtureEvidence(state, pool.id, evidence);
    return { poolId: pool.id, evidence, detail: evidence.error ?? "fixture 未执行" };
  }
  const keyResult = await fetchPoolKeys([pool.id]);
  const key = keyResult.keys.get(pool.id);
  if (!key || !key.vaultA || !key.vaultB) {
    const evidence: FixtureEvidence = { fixtureCount: 0, fixtureCandidateCount: 0, fixtureParsedCount: 0, fixtureUnsupportedCount: 0, fixtureAmountFailureCount: 0, parserSuccessRate: null, checkedAt: now.toISOString(), source: "rpc_fixture_20", error: keyResult.error ?? "Pool Keys 不完整，未进入 fixture" };
    recordFixtureEvidence(state, pool.id, evidence);
    return { poolId: pool.id, evidence, detail: evidence.error ?? "fixture 未执行" };
  }
  const verification = await reconcilePools({ provider, pools: [pool], keys: keyResult.keys, slot: null });
  const account = verification.verification.get(pool.id);
  if (!account?.active || !account.programVerified || !account.mintsVerified || !account.vaultsVerified) {
    const evidence: FixtureEvidence = { fixtureCount: 0, fixtureCandidateCount: 0, fixtureParsedCount: 0, fixtureUnsupportedCount: 0, fixtureAmountFailureCount: 0, parserSuccessRate: null, checkedAt: now.toISOString(), source: "rpc_fixture_20", error: "身份、Program、Mint 或 Vault 核验未通过，未拉取 fixture" };
    recordFixtureEvidence(state, pool.id, evidence);
    return { poolId: pool.id, evidence, detail: evidence.error ?? "fixture 未执行" };
  }
  const signaturesResponse = await rpcRequest<FixtureSignature[]>(provider, "getSignaturesForAddress", [pool.id, { limit: 100, commitment: "confirmed" }], 20_000);
  if (signaturesResponse.error) {
    const evidence: FixtureEvidence = { fixtureCount: 0, fixtureCandidateCount: 0, fixtureParsedCount: 0, fixtureUnsupportedCount: 0, fixtureAmountFailureCount: 0, parserSuccessRate: null, checkedAt: now.toISOString(), source: "rpc_fixture_20", error: signaturesResponse.error };
    recordFixtureEvidence(state, pool.id, evidence);
    return { poolId: pool.id, evidence, detail: evidence.error ?? "fixture 未执行" };
  }
  const signatures = [...new Map((signaturesResponse.result ?? [])
    .filter((item) => typeof item.signature === "string" && !item.err)
    .map((item) => [item.signature, { signature: item.signature, slot: typeof item.slot === "number" ? item.slot : null, blockTime: typeof item.blockTime === "number" ? item.blockTime : null, err: Boolean(item.err) }]))
    .values()].slice(0, 20);
  const cached = readRpcTransactionCache(signatures.map((item) => item.signature));
  const missing = signatures.filter((item) => !cached.has(item.signature));
  const fetched = new Map<string, { transaction: HistoricalTransaction | null; error: string | null }>();
  for (const item of signatures) {
    const row = cached.get(item.signature);
    if (row) fetched.set(item.signature, { transaction: row.status === "SUCCESS" && row.payload ? row.payload as HistoricalTransaction : null, error: row.status === "FAILED" ? row.error ?? "交易缓存标记失败" : null });
  }
  if (missing.length > 0) {
    const results = await rpcBatchRequest<HistoricalTransaction>(provider, missing.map((item, index) => ({ id: index + 1, method: "getTransaction", params: [item.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }] })));
    const cacheRows: CachedRpcTransaction[] = [];
    for (const [index, item] of missing.entries()) {
      const result = results[index];
      const transaction = result?.result ?? null;
      const error = result?.error ?? (transaction ? null : "getTransaction 返回空");
      fetched.set(item.signature, { transaction, error });
      cacheRows.push({ signature: item.signature, slot: transaction?.slot ?? item.slot, blockTime: transaction?.blockTime ?? item.blockTime, payload: transaction, status: transaction ? "SUCCESS" : "FAILED", error, fetchedAt: now.toISOString(), providerUrl: provider.url });
    }
    persistRpcTransactionCache(cacheRows);
  }
  const programPool = admissionProgramPool(pool, new Map([[pool.id, { vaultA: key.vaultA, vaultB: key.vaultB }]]));
  const classifications = [] as import("@/packages/models/src").TransactionClassification[];
  const events = [] as import("@/packages/models/src").SwapEventRecord[];
  const candidateSignatures = new Set<string>();
  const parsedSignatures = new Set<string>();
  const unsupportedSignatures = new Set<string>();
  const amountFailureSignatures = new Set<string>();
  for (const item of signatures) {
    const record = fetched.get(item.signature);
    if (!record?.transaction || record.error) continue;
    const parsed = parseProgramTransaction(programPool, item.signature, record.transaction, now.toISOString());
    classifications.push(...parsed.classifications);
    for (const classification of parsed.classifications) {
      if (isFixtureCandidate(classification.errorCategory)) candidateSignatures.add(item.signature);
      if (classification.errorCategory === "PARSED_SWAP") parsedSignatures.add(item.signature);
      if (["PROGRAM_UNSUPPORTED", "INSTRUCTION_DISCRIMINATOR_UNKNOWN", "FEE_VERSION_UNSUPPORTED"].includes(classification.errorCategory)) unsupportedSignatures.add(item.signature);
      if (classification.errorCategory === "AMOUNT_RECONCILIATION_FAILED") amountFailureSignatures.add(item.signature);
    }
    events.push(...parsed.events);
  }
  if (classifications.length > 0) persistTransactionClassifications(classifications);
  if (events.length > 0) persistNormalizedSwaps(events, "raydium-swap-parser-v2");
  const fixtureCount = candidateSignatures.size;
  const parsedCount = parsedSignatures.size;
  const evidence: FixtureEvidence = {
    fixtureCount,
    fixtureCandidateCount: fixtureCount,
    fixtureParsedCount: parsedCount,
    fixtureUnsupportedCount: unsupportedSignatures.size,
    fixtureAmountFailureCount: amountFailureSignatures.size,
    parserSuccessRate: fixtureCount > 0 ? (parsedCount / fixtureCount) * 100 : null,
    checkedAt: now.toISOString(),
    source: "rpc_fixture_20",
    error: fixtureCount >= 20 ? null : `仅获得 ${fixtureCount}/20 个真实 Swap candidate fixture`,
  };
  recordFixtureEvidence(state, pool.id, evidence);
  return { poolId: pool.id, evidence, detail: evidence.error ?? `fixture ${fixtureCount}/20，解析成功率 ${evidence.parserSuccessRate?.toFixed(2)}%` };
}

export function unknownInstructionRate(admission: PoolAdmission): number | null {
  if (admission.fixtureCount <= 0) return null;
  return (admission.fixtureUnsupportedCount / admission.fixtureCount) * 100;
}

export function expansionDiagnostics(state: UniverseExpansionState | null): Record<string, unknown> {
  if (!state) return { status: "NOT_STARTED" };
  return {
    stage: state.stage,
    UNIVERSE_5_READY: state.UNIVERSE_5_READY,
    TVL_FILTERED_UNIVERSE_READY: state.TVL_FILTERED_UNIVERSE_READY,
    stablePoolIds: state.stablePoolIds,
    tier1PoolIds: state.tier1PoolIds,
    tier2PoolIds: state.tier2PoolIds,
    activeShortWindowPoolIds: state.activeShortWindowPoolIds,
    formalRankingPoolIds: state.formalRankingPoolIds,
    gates: state.gates,
    admission: Object.fromEntries(Object.entries(state.admission).map(([poolId, item]) => [poolId, { ...item, unknownInstructionRate: unknownInstructionRate(item) }])),
    rollbackReason: state.rollbackReason,
  };
}

export function isFixtureCandidate(category: string): boolean {
  return FIXTURE_CANDIDATE_CATEGORIES.has(category);
}
