const RAYDIUM_FEE_URL = "https://api-v3.raydium.io/pools/info/list-v2?size=1000&hasReward=false&sortField=fee24h&sortType=desc";
const METEORA_FEE_URL = "https://dlmm.datapi.meteora.ag/pools?page=1&page_size=1000&sort_by=fee_24h:desc&filter_by=is_blacklisted=false";
const METEORA_USDC_URL = "https://dlmm.datapi.meteora.ag/pools?page=1&page_size=1000&sort_by=fee_24h:desc&filter_by=is_blacklisted=false&query=USDC";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function finite(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function pairLabel(left, right, fallback = "未知交易对") {
  const leftSymbol = left?.symbol || left?.address?.slice(0, 6) || null;
  const rightSymbol = right?.symbol || right?.address?.slice(0, 6) || null;
  return leftSymbol && rightSymbol ? `${leftSymbol}/${rightSymbol}` : fallback;
}

function raydiumFeeRow(pool) {
  return {
    dex: "Raydium",
    pair: pairLabel(pool.mintA, pool.mintB),
    poolAddress: typeof pool.id === "string" ? pool.id : null,
    tvl: finite(pool.tvl),
    volume24h: finite(pool.day?.volume),
    lpFee24h: finite(pool.day?.volumeFee),
    feeTier: finite(pool.feeRate),
    poolType: pool.type || "Pool",
    source: "Raydium API v3",
    assetMint: null,
    quoteMint: null,
  };
}

function meteoraFeeRow(pool) {
  const tokenX = pool.token_x ?? {};
  const tokenY = pool.token_y ?? {};
  const baseFeePercent = finite(pool.pool_config?.base_fee_pct);
  const dynamicFeePercent = finite(pool.dynamic_fee_pct);
  return {
    dex: "Meteora",
    pair: typeof pool.name === "string" && pool.name.includes("-")
      ? pool.name.replaceAll("-", "/")
      : pairLabel(tokenX, tokenY),
    poolAddress: typeof pool.address === "string" ? pool.address : null,
    tvl: finite(pool.tvl),
    volume24h: finite(pool.volume?.["24h"]),
    lpFee24h: finite(pool.fees?.["24h"]),
    feeTier: baseFeePercent === null ? null : baseFeePercent / 100,
    feeMode: dynamicFeePercent !== null && baseFeePercent !== null && dynamicFeePercent > baseFeePercent ? "DYNAMIC" : "BASE",
    poolType: "DLMM",
    source: "Meteora DLMM API",
    assetMint: tokenX.address === USDC_MINT ? tokenY.address : tokenX.address,
    quoteMint: tokenX.address === USDC_MINT ? tokenX.address : tokenY.address === USDC_MINT ? tokenY.address : null,
  };
}

function validFeeRow(row) {
  return row.poolAddress && row.pair && row.lpFee24h !== null && row.volume24h !== null && row.tvl !== null;
}

function rankFeeRows(rows, limit = 10) {
  return rows
    .filter(validFeeRow)
    .sort((left, right) => right.lpFee24h - left.lpFee24h || right.volume24h - left.volume24h || left.poolAddress.localeCompare(right.poolAddress))
    .slice(0, limit)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Official fee source failed: ${response.status} ${url}`);
  return response.json();
}

async function fetchMeteoraUsdcPools(fetchImpl) {
  const first = await fetchJson(METEORA_USDC_URL, fetchImpl);
  const pages = Math.max(1, Number(first.pages) || 1);
  if (pages === 1) return Array.isArray(first.data) ? first.data : [];
  const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, offset) => fetchJson(
    `${METEORA_USDC_URL.replace("page=1", `page=${offset + 2}`)}`,
    fetchImpl,
  )));
  return [first, ...rest].flatMap((page) => Array.isArray(page.data) ? page.data : []);
}

export async function fetchFeeLeaderboards({ rwaPools = [], fetchImpl = fetch } = {}) {
  const [raydiumPayload, meteoraPayload, meteoraUsdcPools] = await Promise.all([
    fetchJson(RAYDIUM_FEE_URL, fetchImpl),
    fetchJson(METEORA_FEE_URL, fetchImpl),
    fetchMeteoraUsdcPools(fetchImpl),
  ]);
  const raydiumPools = Array.isArray(raydiumPayload?.data?.data) ? raydiumPayload.data.data : [];
  const meteoraPools = Array.isArray(meteoraPayload?.data) ? meteoraPayload.data : [];
  const rwaMints = new Set(rwaPools.map((pool) => pool.assetMint).filter(Boolean));
  const raydiumRwa = rwaPools.map((pool) => ({
    dex: "Raydium",
    pair: `${pool.symbol}/USDC`,
    poolAddress: pool.poolAddress,
    tvl: pool.tvl,
    volume24h: pool.volume24h,
    lpFee24h: pool.lpFee24h,
    feeTier: pool.feeTier,
    poolType: pool.poolType,
    source: "Raydium API v3 RWA",
    assetMint: pool.assetMint,
    quoteMint: pool.quoteMint,
  }));
  const meteoraRwa = meteoraUsdcPools
    .map(meteoraFeeRow)
    .filter((row) => row.quoteMint === USDC_MINT && rwaMints.has(row.assetMint));
  const allRows = [...raydiumPools.map(raydiumFeeRow), ...meteoraPools.map(meteoraFeeRow)];
  return {
    generatedAt: new Date().toISOString(),
    sources: {
      raydium: RAYDIUM_FEE_URL,
      meteora: METEORA_FEE_URL,
      meteoraRwa: METEORA_USDC_URL,
    },
    overall: rankFeeRows(allRows),
    rwa: rankFeeRows([...raydiumRwa, ...meteoraRwa]),
  };
}

export const FEE_LEADERBOARD_SOURCES = Object.freeze({
  raydium: RAYDIUM_FEE_URL,
  meteora: METEORA_FEE_URL,
  meteoraRwa: METEORA_USDC_URL,
});

export { rankFeeRows, raydiumFeeRow, meteoraFeeRow };
