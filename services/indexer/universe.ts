import type { ResearchUniverse, ResearchUniverseEntry } from "@/packages/models/src";
import type { RaydiumPoolInfo } from "@/services/raydium/api";
import { RAYDIUM_PROGRAM_IDS, USDC_MINT } from "@/services/raydium/config";
import { persistIndexerState, readIndexerState } from "@/services/storage/event-index";

export const PRIORITY_SYMBOLS = ["SPCX", "SPCXx", "NVDAX", "DRAM", "SPYx", "CRCLx", "SKHY", "TSLAx", "SNDK"] as const;
export const RESEARCH_TVL_ENTRY_USD = 5_000 as const;
export const RESEARCH_TVL_EXIT_USD = 4_000 as const;
export const RESEARCH_ENTRY_DELAY_MS = 10 * 60_000;
export const RESEARCH_EXIT_DELAY_MS = 30 * 60_000;
export const RESEARCH_UNIVERSE_STATE_KEY = "research.universe";

function poolSymbol(pool: RaydiumPoolInfo): string {
  return pool.mintA.address === USDC_MINT ? pool.mintB.symbol : pool.mintA.symbol;
}

function poolPairKey(pool: RaydiumPoolInfo): string {
  return pool.mintA.address === USDC_MINT ? pool.mintB.address : pool.mintA.address;
}

function volumeRank(pool: RaydiumPoolInfo): number {
  return pool.day.volume ?? pool.day.volumeFee ?? -Infinity;
}

function validIdentity(pool: RaydiumPoolInfo): boolean {
  return pool.pooltype.includes("RWA")
    && ((pool.mintA.address === USDC_MINT && pool.mintB.address !== USDC_MINT)
      || (pool.mintB.address === USDC_MINT && pool.mintA.address !== USDC_MINT))
    && RAYDIUM_PROGRAM_IDS.has(pool.programId)
    && pool.identityConflict === null
    && pool.kind !== null;
}

function previousState(): ResearchUniverse | null {
  const state = readIndexerState<ResearchUniverse>(RESEARCH_UNIVERSE_STATE_KEY);
  return state?.entries && Array.isArray(state.activePoolIds) ? state : null;
}

function elapsed(now: number, value: string | null): number {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.max(0, now - time) : 0;
}

function entryFor(pool: RaydiumPoolInfo, now: Date, prior: ResearchUniverseEntry | undefined): ResearchUniverseEntry {
  const evaluatedAt = now.toISOString();
  const tvl = pool.tvl;
  if (!validIdentity(pool)) {
    return {
      poolId: pool.id,
      status: "QUARANTINED",
      tvl,
      aboveThresholdSince: null,
      belowExitThresholdSince: null,
      lastEvaluatedAt: evaluatedAt,
      reason: pool.identityConflict ?? "Pool身份、Mint或Program类型存在冲突",
    };
  }
  if (pool.isActive === false) {
    return {
      poolId: pool.id,
      status: "OFFICIAL_ONLY",
      tvl,
      aboveThresholdSince: null,
      belowExitThresholdSince: null,
      lastEvaluatedAt: evaluatedAt,
      reason: "官方 API 标记为不可交易，仅保留官方数据",
    };
  }
  if (tvl === null) {
    return {
      poolId: pool.id,
      status: "OFFICIAL_ONLY",
      tvl: null,
      aboveThresholdSince: null,
      belowExitThresholdSince: null,
      lastEvaluatedAt: evaluatedAt,
      reason: "官方 API 未提供 TVL，不能进入研究 Universe",
    };
  }

  const wasActive = prior?.status === "ACTIVE_INDEXED";
  if (wasActive) {
    if (tvl < RESEARCH_TVL_EXIT_USD) {
      const belowSince = prior?.belowExitThresholdSince ?? evaluatedAt;
      return {
        poolId: pool.id,
        status: elapsed(now.getTime(), belowSince) >= RESEARCH_EXIT_DELAY_MS ? "OFFICIAL_ONLY" : "ACTIVE_INDEXED",
        tvl,
        aboveThresholdSince: null,
        belowExitThresholdSince: belowSince,
        lastEvaluatedAt: evaluatedAt,
        reason: elapsed(now.getTime(), belowSince) >= RESEARCH_EXIT_DELAY_MS
          ? "TVL 已连续30分钟低于 4,000 美元，暂停短窗口索引"
          : "TVL 低于退出线但仍在30分钟迟滞期内，保持当前状态",
      };
    }
    return {
      poolId: pool.id,
      status: "ACTIVE_INDEXED",
      tvl,
      aboveThresholdSince: prior?.aboveThresholdSince ?? evaluatedAt,
      belowExitThresholdSince: null,
      lastEvaluatedAt: evaluatedAt,
      reason: "TVL 达到研究门槛，已进入实时与历史索引",
    };
  }

  if (tvl >= RESEARCH_TVL_ENTRY_USD) {
    const aboveSince = prior?.aboveThresholdSince ?? evaluatedAt;
    const ready = elapsed(now.getTime(), aboveSince) >= RESEARCH_ENTRY_DELAY_MS;
    return {
      poolId: pool.id,
      status: ready ? "ACTIVE_INDEXED" : "OFFICIAL_ONLY",
      tvl,
      aboveThresholdSince: aboveSince,
      belowExitThresholdSince: null,
      lastEvaluatedAt: evaluatedAt,
      reason: ready
        ? "TVL 已连续10分钟达到 5,000 美元，进入研究 Universe"
        : "TVL 已达到 5,000 美元，等待连续10分钟确认",
    };
  }

  return {
    poolId: pool.id,
    status: "OFFICIAL_ONLY",
    tvl,
    aboveThresholdSince: null,
    belowExitThresholdSince: null,
    lastEvaluatedAt: evaluatedAt,
    reason: tvl < RESEARCH_TVL_EXIT_USD
      ? "TVL 低于 5,000 美元，仅保留官方24小时数据"
      : "TVL 位于 4,000–5,000 美元迟滞区，尚未达到进入条件",
  };
}

export function evaluateResearchUniverse(
  pools: RaydiumPoolInfo[],
  now = new Date(),
  options: { previous?: ResearchUniverse | null; persist?: boolean } = {},
): ResearchUniverse {
  const previous = options.previous === undefined ? previousState() : options.previous;
  const entries = Object.fromEntries(pools.map((pool) => [pool.id, entryFor(pool, now, previous?.entries[pool.id])])) as Record<string, ResearchUniverseEntry>;
  const activePoolIds = Object.values(entries).filter((entry) => entry.status === "ACTIVE_INDEXED").map((entry) => entry.poolId);
  const activePairIds = new Set(pools.filter((pool) => activePoolIds.includes(pool.id)).map(poolPairKey));
  const officialOnlyPairIds = new Set(pools.filter((pool) => entries[pool.id]?.status === "OFFICIAL_ONLY").map(poolPairKey));
  const universe: ResearchUniverse = {
    generatedAt: now.toISOString(),
    entryTvlUsd: RESEARCH_TVL_ENTRY_USD,
    exitTvlUsd: RESEARCH_TVL_EXIT_USD,
    entryDelayMs: RESEARCH_ENTRY_DELAY_MS,
    exitDelayMs: RESEARCH_EXIT_DELAY_MS,
    poolCountBeforeFilter: pools.length,
    activePoolCount: activePoolIds.length,
    officialOnlyPoolCount: Object.values(entries).filter((entry) => entry.status === "OFFICIAL_ONLY").length,
    quarantinedPoolCount: Object.values(entries).filter((entry) => entry.status === "QUARANTINED").length,
    activePairCount: activePairIds.size,
    officialOnlyPairCount: officialOnlyPairIds.size,
    activePoolIds,
    entries,
  };
  if (options.persist !== false) persistIndexerState(RESEARCH_UNIVERSE_STATE_KEY, universe);
  return universe;
}

export function selectResearchPools(pools: RaydiumPoolInfo[], universe: ResearchUniverse): RaydiumPoolInfo[] {
  const active = new Set(universe.activePoolIds);
  return pools.filter((pool) => active.has(pool.id));
}

export function classifyUniverseTiers(pools: RaydiumPoolInfo[], universe?: ResearchUniverse): { tier1: RaydiumPoolInfo[]; tier2: RaydiumPoolInfo[]; tier3: RaydiumPoolInfo[] } {
  const activeIds = new Set(universe?.activePoolIds ?? pools.map((pool) => pool.id));
  const priority = new Set<string>(PRIORITY_SYMBOLS);
  const activePools = pools.filter((pool) => activeIds.has(pool.id));
  const tier1 = activePools.filter((pool) => priority.has(poolSymbol(pool)));
  const tier2 = activePools.filter((pool) => !priority.has(poolSymbol(pool))).sort((left, right) => volumeRank(right) - volumeRank(left));
  const tier3 = pools.filter((pool) => !activeIds.has(pool.id));
  return { tier1, tier2, tier3 };
}
