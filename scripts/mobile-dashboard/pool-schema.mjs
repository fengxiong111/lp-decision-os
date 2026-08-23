export const POOL_SCHEMA_VERSION = 1;

export function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function string(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function createPoolSchema(fields) {
  return {
    schemaVersion: POOL_SCHEMA_VERSION,
    dex: fields.dex,
    poolType: fields.poolType,
    poolAddress: fields.poolAddress,
    programId: fields.programId ?? null,
    pair: fields.pair,
    baseMint: fields.baseMint ?? null,
    quoteMint: fields.quoteMint ?? null,
    baseSymbol: fields.baseSymbol ?? null,
    quoteSymbol: fields.quoteSymbol ?? null,
    tvl: finite(fields.tvl),
    volume24h: finite(fields.volume24h),
    lpFee24h: finite(fields.lpFee24h),
    feeTier: finite(fields.feeTier),
    feeMode: fields.feeMode ?? null,
    feeApr24h: finite(fields.feeApr24h),
    apr24h: finite(fields.apr24h),
    volumeTvl: finite(fields.volumeTvl),
    feeTvl: finite(fields.feeTvl),
    currentPrice: finite(fields.currentPrice),
    priceMin: finite(fields.priceMin),
    priceMax: finite(fields.priceMax),
    priceVolatilityPct: finite(fields.priceVolatilityPct),
    activeTimeHours: finite(fields.activeTimeHours),
    activeTimeSource: fields.activeTimeSource ?? null,
    tickSpacing: finite(fields.tickSpacing),
    currentTick: finite(fields.currentTick),
    binStep: finite(fields.binStep),
    isBlacklisted: fields.isBlacklisted === true,
    tags: Array.isArray(fields.tags) ? fields.tags : [],
    washVolumeStatus: fields.washVolumeStatus ?? "NOT_VERIFIED",
    source: fields.source ?? null,
    sourceRecord: fields.sourceRecord,
    replayEvidence: fields.replayEvidence ?? null,
  };
}

export function validatePoolSchema(pool) {
  return Boolean(pool)
    && pool.schemaVersion === POOL_SCHEMA_VERSION
    && typeof pool.dex === "string"
    && typeof pool.poolType === "string"
    && typeof pool.poolAddress === "string"
    && typeof pool.pair === "string"
    && [pool.tvl, pool.volume24h, pool.lpFee24h, pool.feeTier, pool.feeApr24h, pool.volumeTvl, pool.feeTvl, pool.currentPrice].every((value) => value === null || Number.isFinite(value));
}

export const PoolSchema = Object.freeze({
  version: POOL_SCHEMA_VERSION,
  validate: validatePoolSchema,
});
