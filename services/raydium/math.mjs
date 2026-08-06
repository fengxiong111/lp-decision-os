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
  return (coverage?.backfillStatus === "COMPLETE" || coverage?.backfillStatus === "LIVE") && coverage.coverageRatio === 100 && coverage.gapSlots === 0 && coverage.unknownInstructions === 0;
}

export function identityKey({ baseMint, quoteMint, poolAddress, positionNftMint = "" }) {
  return [baseMint, quoteMint, poolAddress, positionNftMint].join(":");
}
