import type { RaydiumPoolInfo } from "@/services/raydium/api";

export const PRIORITY_SYMBOLS = ["SPCX", "SPCXx", "NVDAX", "DRAM", "SPYx", "CRCLx", "SKHY", "TSLAx", "SNDK"] as const;
export const SHORT_WINDOW_POOL_LIMIT = 20;

function poolSymbol(pool: RaydiumPoolInfo): string {
  return pool.mintA.address === USDC_MINT ? pool.mintB.symbol : pool.mintA.symbol;
}

function volumeRank(pool: RaydiumPoolInfo): number {
  return pool.day.volume ?? pool.day.volumeFee ?? -Infinity;
}

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/**
 * The short-window product is deliberately bounded. A bounded universe makes
 * coverage truthful and puts the RPC budget behind active decision candidates.
 * The public snapshot still carries every discovered pool.
 */
export function selectTop20Pools(pools: RaydiumPoolInfo[]): RaydiumPoolInfo[] {
  const selected: RaydiumPoolInfo[] = [];
  const selectedIds = new Set<string>();
  for (const symbol of PRIORITY_SYMBOLS) {
    const candidate = pools
      .filter((pool) => poolSymbol(pool) === symbol)
      .sort((left, right) => volumeRank(right) - volumeRank(left))[0];
    if (candidate && !selectedIds.has(candidate.id)) {
      selected.push(candidate);
      selectedIds.add(candidate.id);
    }
  }
  for (const pool of [...pools].sort((left, right) => volumeRank(right) - volumeRank(left))) {
    if (selected.length >= SHORT_WINDOW_POOL_LIMIT) break;
    if (!selectedIds.has(pool.id)) {
      selected.push(pool);
      selectedIds.add(pool.id);
    }
  }
  return selected;
}

export function selectTop20PoolIds(pools: RaydiumPoolInfo[]): string[] {
  return selectTop20Pools(pools).map((pool) => pool.id);
}

export function top20UniverseLabel(pools: RaydiumPoolInfo[]): string {
  return `Top ${selectTop20Pools(pools).length} 活跃 RWA/USDC Pool`;
}

export function classifyUniverseTiers(pools: RaydiumPoolInfo[]): { tier1: RaydiumPoolInfo[]; tier2: RaydiumPoolInfo[]; tier3: RaydiumPoolInfo[] } {
  const top20 = new Set(selectTop20Pools(pools).map((pool) => pool.id));
  const priority = new Set<string>(PRIORITY_SYMBOLS);
  const tier1 = pools.filter((pool) => priority.has(poolSymbol(pool)));
  const tier2 = pools.filter((pool) => top20.has(pool.id) && !tier1.some((item) => item.id === pool.id));
  const tier3 = pools.filter((pool) => !tier1.some((item) => item.id === pool.id) && !tier2.some((item) => item.id === pool.id));
  return { tier1, tier2, tier3 };
}
