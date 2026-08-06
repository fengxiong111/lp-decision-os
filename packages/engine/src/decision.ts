import type { Decision, PoolSnapshot } from "@/packages/models/src";

export function buildDecision(pool: PoolSnapshot, capital: number): Decision | null {
  if (!Number.isFinite(capital) || capital <= 0) return null;
  if (pool.expectedNetYield === null || pool.confidence === null || pool.confidence < 80) return null;
  if (pool.quality.status === "blocked" || pool.verification.active === false) return null;

  return {
    poolId: pool.id,
    pair: pool.pair,
    feeTier: pool.feeTier,
    range: pool.recommendedRange,
    positionSize: capital,
    expectedNetYield: pool.expectedNetYield,
    confidence: pool.confidence,
    rationale: [
      "净收益已经通过执行成本校验",
      "Pool 账户、Mint 和 Vault 已完成链上复核",
      "价格区间和容量均有可用事件数据",
    ],
  };
}

export function rankPools(pools: PoolSnapshot[]): PoolSnapshot[] {
  return pools.filter((pool) => pool.expectedNetYield !== null && Number.isFinite(pool.expectedNetYield)).sort((a, b) => {
    const aYield = a.expectedNetYield as number;
    const bYield = b.expectedNetYield as number;
    if (aYield !== bYield) return bYield - aYield;
    const aDensity = a.feeDensity ?? -Infinity;
    const bDensity = b.feeDensity ?? -Infinity;
    if (aDensity !== bDensity) return bDensity - aDensity;
    const aVolume = a.volume24h;
    const bVolume = b.volume24h;
    if (aVolume === null && bVolume !== null) return 1;
    if (aVolume !== null && bVolume === null) return -1;
    return (bVolume ?? 0) - (aVolume ?? 0);
  });
}
