export const U64 = 1n << 64n;
export const U128 = 1n << 128n;

export function modulo128(value) {
  const result = value % U128;
  return result < 0n ? result + U128 : result;
}

export function feeGrowthInside(global, lowerOutside, upperOutside, currentTick, lower, upper) {
  const below = currentTick >= lower ? lowerOutside : modulo128(global - lowerOutside);
  const above = currentTick < upper ? upperOutside : modulo128(global - upperOutside);
  return modulo128(global - below - above);
}

export function currentOwed(liquidity, inside, last, owed) {
  return owed + (liquidity * modulo128(inside - last)) / U64;
}

export function coverageIsComplete(coverage) {
  if (!coverage || (coverage.backfillStatus !== "COMPLETE" && coverage.backfillStatus !== "LIVE")) return false;
  const start = Date.parse(coverage.windowStart ?? "");
  const oldest = Date.parse(coverage.oldestCoveredBlockTime ?? coverage.oldestCoveredAt ?? "");
  return Number.isFinite(start)
    && Number.isFinite(oldest)
    && oldest <= start
    && coverage.unresolvedRetryableTransactions === 0
    && (coverage.gapCount ?? coverage.gapSlots) === 0
    && Number.isFinite(coverage.metricsBucketCount)
    && coverage.metricsBucketCount >= (coverage.expectedBucketCount ?? 0);
}

export function identityKey({ baseMint, quoteMint, poolAddress, positionNftMint = "" }) {
  return [baseMint, quoteMint, poolAddress, positionNftMint].join(":");
}
