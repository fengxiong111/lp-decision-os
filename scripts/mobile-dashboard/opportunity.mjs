const FEATURE_WEIGHTS = Object.freeze({
  volume24h: 0.30,
  lpFee24h: 0.30,
  tvl: 0.15,
  feeTier: 0.10,
  liquidity: 0.10,
  priceActivity: 0.05,
});

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function metricValue(value) {
  const numeric = finite(value);
  return numeric !== null && numeric >= 0 ? numeric : null;
}

function percentileScores(values) {
  const valid = values.filter((value) => value !== null).map((value) => Math.log10(1 + Math.max(0, value)));
  if (valid.length === 0) return values.map(() => null);
  const minimum = Math.min(...valid);
  const maximum = Math.max(...valid);
  return values.map((value) => {
    if (value === null) return null;
    const transformed = Math.log10(1 + Math.max(0, value));
    return maximum === minimum ? 50 : ((transformed - minimum) / (maximum - minimum)) * 100;
  });
}

function priceActivityProxy(pool) {
  const tvl = metricValue(pool.tvl);
  const volume = metricValue(pool.volume24h);
  if (tvl === null || tvl <= 0 || volume === null) return null;
  return volume / tvl;
}

function featureValues(pools) {
  return {
    volume24h: pools.map((pool) => metricValue(pool.volume24h)),
    lpFee24h: pools.map((pool) => metricValue(pool.lpFee24h)),
    tvl: pools.map((pool) => metricValue(pool.tvl)),
    feeTier: pools.map((pool) => metricValue(pool.feeTier)),
    liquidity: pools.map((pool) => metricValue(pool.activeLiquidity)),
    priceActivity: pools.map(priceActivityProxy),
  };
}

function scoreFeatures(pool, pools, values) {
  const scores = {};
  const raw = {
    volume24h: metricValue(pool.volume24h),
    lpFee24h: metricValue(pool.lpFee24h),
    tvl: metricValue(pool.tvl),
    feeTier: metricValue(pool.feeTier),
    liquidity: metricValue(pool.activeLiquidity),
    priceActivity: priceActivityProxy(pool),
  };
  let weighted = 0;
  let knownWeight = 0;
  for (const [key, weight] of Object.entries(FEATURE_WEIGHTS)) {
    const score = percentileScores(values[key])[pools.indexOf(pool)];
    scores[key] = score;
    if (score === null) continue;
    weighted += score * weight;
    knownWeight += weight;
  }
  return {
    raw,
    scores,
    value: knownWeight > 0 ? weighted / knownWeight : null,
    knownWeight,
    coverage: knownWeight / Object.values(FEATURE_WEIGHTS).reduce((sum, weight) => sum + weight, 0),
    sources: {
      volume24h: "Raydium API v3 day.volume",
      lpFee24h: "Raydium API v3 day.volumeFee",
      tvl: "Raydium API v3 tvl",
      feeTier: "Raydium API v3 feeRate",
      liquidity: raw.liquidity === null ? "等待 PoolState liquidity" : "PoolState liquidity",
      priceActivity: "24h volume / TVL turnover proxy",
    },
  };
}

function opportunityStatus(diagnostic) {
  if (diagnostic?.status === "READY") return "READY";
  if (diagnostic?.status === "NEAR_READY") return "WATCH";
  return diagnostic?.blockerClass === "HARD_INVALID" ? "BLOCKED" : "WATCH";
}

function actionForOpportunity(status, score) {
  if (status === "READY") return "OPEN_READY";
  if (status === "BLOCKED") return score !== null && score >= 60 ? "REVIEW" : "BLOCKED";
  return "WATCH";
}

function confidenceForOpportunity(featureScore, diagnostic) {
  const opportunityCoverage = featureScore?.coverage ?? 0;
  const verificationCoverage = diagnostic?.totalChecks > 0 ? diagnostic.passCount / diagnostic.totalChecks : 0;
  return Math.round((opportunityCoverage * 60 + verificationCoverage * 40) * 10) / 10;
}

export function buildOpportunityRanking(pools, optimizerResults, diagnostics) {
  const values = featureValues(pools);
  const diagnosticByPool = new Map((diagnostics?.matrix ?? []).map((row) => [row.poolAddress, row]));
  const optimizerByPool = new Map(optimizerResults.map(({ pool, optimizer }) => [pool.poolAddress, { pool, optimizer }]));
  const scored = pools.map((pool) => {
    const featureScore = scoreFeatures(pool, pools, values);
    const diagnostic = diagnosticByPool.get(pool.poolAddress) ?? null;
    const optimizer = optimizerByPool.get(pool.poolAddress)?.optimizer ?? null;
    const best = optimizer?.best ?? null;
    const status = opportunityStatus(diagnostic);
    return {
      pool,
      diagnostic,
      opportunityStatus: status,
      opportunityScore: featureScore.value === null ? null : Math.round(featureScore.value * 10) / 10,
      netEstimate: finite(diagnostic?.netRange?.NET_BASE),
      core: best?.core ?? null,
      coreCapital: finite(best?.coreCapital),
      buffer: best?.buffer ?? null,
      bufferCapital: finite(best?.bufferCapital),
      confidence: confidenceForOpportunity(featureScore, diagnostic),
      action: actionForOpportunity(status, featureScore.value),
      featureScore,
    };
  }).sort((left, right) => {
    return (right.opportunityScore ?? -Infinity) - (left.opportunityScore ?? -Infinity)
      || (right.pool.volume24h ?? -Infinity) - (left.pool.volume24h ?? -Infinity)
      || left.pool.poolAddress.localeCompare(right.pool.poolAddress);
  });

  const seenPoolVariants = new Set();
  const uniqueCandidates = scored.filter((candidate) => {
    const feeTier = metricValue(candidate.pool.feeTier);
    const key = `${candidate.pool.symbol}/USDC::${feeTier === null ? "unknown" : feeTier}`;
    if (seenPoolVariants.has(key)) return false;
    seenPoolVariants.add(key);
    return true;
  });
  const top3 = uniqueCandidates.slice(0, 3).map((candidate, index) => ({
    rank: index + 1,
    pair: `${candidate.pool.symbol}/USDC`,
    poolAddress: candidate.pool.poolAddress,
    tvl: metricValue(candidate.pool.tvl),
    volume24h: metricValue(candidate.pool.volume24h),
    lpFee24h: metricValue(candidate.pool.lpFee24h),
    feeTier: metricValue(candidate.pool.feeTier),
    opportunityScore: candidate.opportunityScore,
    opportunityStatus: candidate.opportunityStatus,
    netEstimate: candidate.netEstimate,
    coreCapital: candidate.coreCapital,
    coreLower: candidate.core?.lowerPrice ?? null,
    coreUpper: candidate.core?.upperPrice ?? null,
    bufferCapital: candidate.bufferCapital,
    bufferLower: candidate.buffer?.lowerPrice ?? null,
    bufferUpper: candidate.buffer?.upperPrice ?? null,
    confidence: candidate.confidence,
    action: candidate.action,
    evidence: candidate.diagnostic?.evidence ?? [],
    opportunity: {
      score: candidate.opportunityScore,
      breakdown: candidate.featureScore,
      source: "Raydium API v3 public RWA/USDC market data",
    },
  }));

  return { top3, scored, uniqueCandidateCount: uniqueCandidates.length };
}

export function buildMarketHeatRanking(scored) {
  return scored
    .filter((candidate) => candidate?.pool?.poolAddress)
    .sort((left, right) => {
      return (metricValue(right.pool.lpFee24h) ?? -Infinity) - (metricValue(left.pool.lpFee24h) ?? -Infinity)
        || (metricValue(right.pool.volume24h) ?? -Infinity) - (metricValue(left.pool.volume24h) ?? -Infinity)
        || left.pool.poolAddress.localeCompare(right.pool.poolAddress);
    })
    .map((candidate, index) => ({
      rank: index + 1,
      pair: `${candidate.pool.symbol}/USDC`,
      poolAddress: candidate.pool.poolAddress,
      volume24h: metricValue(candidate.pool.volume24h),
      lpFee24h: metricValue(candidate.pool.lpFee24h),
      tvl: metricValue(candidate.pool.tvl),
      feeTier: metricValue(candidate.pool.feeTier),
    }));
}

export { FEATURE_WEIGHTS };
