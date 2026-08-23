export const SCANNER_FILTERS = Object.freeze({
  tvlMin: 50_000,
  volume24hMin: 50_000,
  maxApr24h: 10_000,
  maxFeeTvlRatio24h: 0.5,
});

function tagsContain(row, values) {
  const text = (row.tags ?? []).map((tag) => String(tag).toLowerCase()).join(" ");
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

export function marketEvidence(pool, filter) {
  return {
    status: filter.eligible ? "PASS" : "BLOCKED",
    volumeTvl: pool.volumeTvl,
    feeTvl: pool.feeTvl,
    tvl: pool.tvl,
    volume24h: pool.volume24h,
    lpFee24h: pool.lpFee24h,
    feeApr24h: pool.feeApr24h,
    reasons: filter.reasons,
  };
}

export class MarketScanner {
  constructor({ filters = SCANNER_FILTERS } = {}) {
    this.filters = filters;
  }

  evaluate(pool) {
    const filter = evaluateScannerFilter(pool, this.filters);
    return { pool, filter, market: marketEvidence(pool, filter) };
  }

  discover(pools) {
    const evaluations = pools.map((pool) => this.evaluate(pool));
    const eligible = evaluations.filter((entry) => entry.filter.eligible);
    return {
      evaluations,
      eligible,
      allPoolCount: pools.length,
      eligiblePoolCount: eligible.length,
      excludedPoolCount: evaluations.length - eligible.length,
      excludedByReason: evaluations.flatMap((entry) => entry.filter.reasons).reduce((counts, reason) => {
        counts[reason] = (counts[reason] ?? 0) + 1;
        return counts;
      }, {}),
    };
  }
}
