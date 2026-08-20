export function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizePrice(rawPrice, asset, quote, config) {
  if (rawPrice === null || rawPrice <= 0) return null;
  const scale = config.priceScaleOverrides[asset.address];
  return scale !== undefined && asset.decimals === 8 && quote.decimals === 6 && quote.address === config.usdcMint
    ? rawPrice * scale
    : rawPrice;
}

function normalizeOptionalBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function normalizeUniverseStatus(pool) {
  return typeof pool.universeStatus === "string" ? pool.universeStatus : null;
}

export function normalizePool(pool, config) {
  if (!Array.isArray(pool.pooltype) || !pool.pooltype.includes("RWA")) return null;
  const mintA = pool.mintA ?? {};
  const mintB = pool.mintB ?? {};
  const asset = mintA.address === config.usdcMint ? mintB : mintB.address === config.usdcMint ? mintA : null;
  const quote = mintA.address === config.usdcMint ? mintA : mintB.address === config.usdcMint ? mintB : null;
  if (!asset?.address || !quote?.address) return null;

  const tvl = finiteNumber(pool.tvl);
  const rawPrice = finiteNumber(pool.price);
  const volume24h = finiteNumber(pool.day?.volume);
  const lpFee24h = finiteNumber(pool.day?.volumeFee);
  if (tvl === null || volume24h === null || lpFee24h === null) return null;

  const normalizedPrice = normalizePrice(rawPrice, asset, quote, config);
  const assetIsToken0 = mintA.address === asset.address;
  const feeRate = finiteNumber(pool.feeRate);
  const tickSpacing = finiteNumber(pool.config?.tickSpacing);
  const tradeFeeRate = finiteNumber(pool.config?.tradeFeeRate);
  const hasDynamicFee = pool.hasDynamicFee === true;

  return {
    assetMint: asset.address,
    symbol: asset.symbol || asset.address.slice(0, 6),
    name: asset.name || "未命名资产",
    poolAddress: pool.id,
    programId: typeof pool.programId === "string" ? pool.programId : null,
    apiMintA: typeof mintA.address === "string" ? mintA.address : null,
    apiMintB: typeof mintB.address === "string" ? mintB.address : null,
    apiDecimalsA: finiteNumber(mintA.decimals),
    apiDecimalsB: finiteNumber(mintB.decimals),
    assetIsToken0,
    poolType: Array.isArray(pool.pooltype) && pool.pooltype.includes("Clmm") ? "CLMM" : pool.type || "Pool",
    universeStatus: normalizeUniverseStatus(pool),
    rwaIdentityVerified: pool.rwaIdentityVerified === true || pool.pooltype.includes("RWA"),
    usdcIdentityVerified: quote.address === config.usdcMint,
    tvl,
    price: mintA.address === config.usdcMint && normalizedPrice !== null ? 1 / normalizedPrice : normalizedPrice,
    currentPrice: finiteNumber(pool.currentPrice) ?? (mintA.address === config.usdcMint && normalizedPrice !== null ? 1 / normalizedPrice : normalizedPrice),
    currentTick: finiteNumber(pool.currentTick),
    tickSpacing,
    tickDirection: assetIsToken0 ? 1 : -1,
    activeLiquidity: finiteNumber(pool.activeLiquidity),
    volume24h,
    lpFee24h,
    apr: finiteNumber(pool.day?.feeApr ?? pool.day?.apr),
    feeTier: feeRate,
    feeRate,
    hasDynamicFee,
    feeConfigVerified: feeRate !== null && (!hasDynamicFee || tradeFeeRate !== null),
    assetDecimals: finiteNumber(asset.decimals),
    quoteDecimals: finiteNumber(quote.decimals),
    quoteMint: quote.address,
    replayEvidence: pool.replayEvidence && typeof pool.replayEvidence === "object" ? pool.replayEvidence : null,
    shadowReplay: pool.shadowReplay && typeof pool.shadowReplay === "object" ? pool.shadowReplay : null,
    executionCosts: pool.executionCosts && typeof pool.executionCosts === "object" ? pool.executionCosts : null,
    shadowPosition: pool.shadowPosition && typeof pool.shadowPosition === "object" ? pool.shadowPosition : null,
    riskFlags: Array.isArray(pool.riskFlags) ? pool.riskFlags : [],
    activeIndexed: normalizeOptionalBoolean(pool.activeIndexed),
  };
}

export function normalizePools(rawPools, config) {
  return rawPools.map((pool) => normalizePool(pool, config)).filter(Boolean);
}
