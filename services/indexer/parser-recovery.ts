import type { RaydiumPoolInfo } from "@/services/raydium/api";
import { USDC_MINT } from "@/services/raydium/config";

/**
 * Parser recovery is deliberately narrower than the public RWA universe.
 * Public discovery may continue to show every eligible pool, but historical
 * transaction work must remain bounded to these two regression cases until
 * their parser acceptance criteria are met.
 */
export const PARSER_RECOVERY_TARGETS = [
  { symbol: "SPCX", feeRate: 0.0025, poolId: "FjuBy7jjf9DXj9d3R7cHpvcnoFW2iQxf7F7P3vqx4Jza" },
  { symbol: "SPCXx", feeRate: 0.008, poolId: "AHNN6JmvaGG6XUoSg7sEr38gRYDB2jTbUvqXVuqaRHpq" },
] as const;

export function parserRecoveryAssetSymbol(pool: RaydiumPoolInfo): string {
  return pool.mintA.address === USDC_MINT ? pool.mintB.symbol : pool.mintA.symbol;
}

export function selectParserRecoveryPools(pools: RaydiumPoolInfo[]): RaydiumPoolInfo[] {
  const exact = PARSER_RECOVERY_TARGETS.flatMap((target) => pools.filter((pool) => pool.id === target.poolId));
  const fallback = PARSER_RECOVERY_TARGETS.flatMap((target) => pools.filter((pool) => {
    const feeRate = pool.feeRate ?? pool.config?.tradeFeeRate ?? null;
    return parserRecoveryAssetSymbol(pool) === target.symbol
      && feeRate !== null
      && Math.abs(feeRate - target.feeRate) <= 1e-7;
  }));
  return [...new Map([...exact, ...fallback].map((pool) => [pool.id, pool])).values()]
    .filter((pool) => PARSER_RECOVERY_TARGETS.some((target) => {
      const feeRate = pool.feeRate ?? pool.config?.tradeFeeRate ?? null;
      return parserRecoveryAssetSymbol(pool) === target.symbol
        && feeRate !== null
        && Math.abs(feeRate - target.feeRate) <= 1e-7;
    }))
    .slice(0, PARSER_RECOVERY_TARGETS.length);
}
