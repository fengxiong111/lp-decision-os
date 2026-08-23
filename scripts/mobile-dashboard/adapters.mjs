import { createPoolSchema, finite, string } from "./pool-schema.mjs";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const RAYDIUM_URL = "https://api-v3.raydium.io/pools/info/list-v2";
export const METEORA_URL = "https://dlmm.datapi.meteora.ag/pools";

export const ADAPTER_LIMITS = Object.freeze({
  pageSize: 1_000,
  maxRaydiumPages: 200,
  maxMeteoraPages: 250,
  apiConcurrency: 6,
});

export const ADAPTER_SOURCES = Object.freeze({
  raydium: RAYDIUM_URL,
  meteora: METEORA_URL,
});

function pairLabel(left, right) {
  const leftSymbol = string(left?.symbol) || string(left?.address)?.slice(0, 8) || "未知资产";
  const rightSymbol = string(right?.symbol) || string(right?.address)?.slice(0, 8) || "未知报价";
  return `${leftSymbol}/${rightSymbol}`;
}

function orderedMints(first, second) {
  if (first?.address === USDC_MINT) return { base: second, quote: first };
  if (second?.address === USDC_MINT) return { base: first, quote: second };
  return { base: first, quote: second };
}

function fetchOptions() {
  return { headers: { accept: "application/json" } };
}

async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url, fetchOptions());
  if (!response.ok) throw new Error(`官方数据源 HTTP ${response.status}: ${url}`);
  return response.json();
}

async function mapWithConcurrency(values, limit, mapper) {
  const output = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return output;
}

export class RaydiumAdapter {
  constructor({ fetchImpl = fetch, pageSize = ADAPTER_LIMITS.pageSize, maxPages = ADAPTER_LIMITS.maxRaydiumPages } = {}) {
    this.fetchImpl = fetchImpl;
    this.pageSize = pageSize;
    this.maxPages = maxPages;
  }

  normalize(raw) {
    const mintA = raw?.mintA ?? {};
    const mintB = raw?.mintB ?? {};
    const { base, quote } = orderedMints(mintA, mintB);
    const tvl = finite(raw?.tvl);
    const volume24h = finite(raw?.day?.volume);
    const lpFee24h = finite(raw?.day?.volumeFee);
    const currentPrice = finite(raw?.price);
    const priceMin = finite(raw?.day?.priceMin);
    const priceMax = finite(raw?.day?.priceMax);
    const priceVolatilityPct = currentPrice !== null && priceMin !== null && priceMax !== null && currentPrice > 0
      ? ((priceMax - priceMin) / currentPrice) * 100
      : null;
    const feeApr24h = finite(raw?.day?.apr ?? raw?.day?.feeApr);
    return createPoolSchema({
      dex: "Raydium",
      poolType: "CLMM",
      poolAddress: string(raw?.id),
      programId: string(raw?.programId),
      pair: pairLabel(base, quote),
      baseMint: string(base?.address),
      quoteMint: string(quote?.address),
      baseSymbol: string(base?.symbol),
      quoteSymbol: string(quote?.symbol),
      tvl,
      volume24h,
      lpFee24h,
      feeTier: finite(raw?.feeRate),
      feeApr24h,
      apr24h: feeApr24h,
      volumeTvl: tvl !== null && tvl > 0 && volume24h !== null ? volume24h / tvl : null,
      feeTvl: tvl !== null && tvl > 0 && lpFee24h !== null ? lpFee24h / tvl : null,
      currentPrice,
      priceMin,
      priceMax,
      priceVolatilityPct,
      activeTimeHours: null,
      activeTimeSource: "官方 Pool 列表未提供逐小时活跃时长",
      tickSpacing: finite(raw?.config?.tickSpacing),
      currentTick: null,
      binStep: null,
      isBlacklisted: false,
      tags: Array.isArray(raw?.tips) ? raw.tips : [],
      washVolumeStatus: "NOT_VERIFIED",
      source: "Raydium API v3",
      sourceRecord: raw,
      replayEvidence: raw?.replayEvidence ?? null,
    });
  }

  async discover() {
    const pools = [];
    let nextPageId = null;
    let pageCount = 0;
    let complete = false;
    const seenCursors = new Set();
    while (pageCount < this.maxPages) {
      const params = new URLSearchParams({
        size: String(this.pageSize),
        hasReward: "false",
        sortField: "volume24h",
        sortType: "desc",
        poolType: "Concentrated",
      });
      if (nextPageId) params.set("nextPageId", nextPageId);
      const payload = await fetchJson(`${RAYDIUM_URL}?${params}`, this.fetchImpl);
      const page = Array.isArray(payload?.data?.data) ? payload.data.data : [];
      pools.push(...page);
      pageCount += 1;
      const cursor = string(payload?.data?.nextPageId);
      if (!cursor || seenCursors.has(cursor)) {
        complete = true;
        break;
      }
      seenCursors.add(cursor);
      nextPageId = cursor;
    }
    return { dex: "Raydium", poolType: "CLMM", pools, pageCount, complete, endpoint: RAYDIUM_URL, pageSize: this.pageSize };
  }
}

export class MeteoraAdapter {
  constructor({ fetchImpl = fetch, pageSize = ADAPTER_LIMITS.pageSize, maxPages = ADAPTER_LIMITS.maxMeteoraPages } = {}) {
    this.fetchImpl = fetchImpl;
    this.pageSize = pageSize;
    this.maxPages = maxPages;
  }

  normalize(raw) {
    const tokenX = raw?.token_x ?? {};
    const tokenY = raw?.token_y ?? {};
    const quoteIsX = tokenX?.address === USDC_MINT;
    const quoteIsY = tokenY?.address === USDC_MINT;
    const base = quoteIsX ? tokenY : tokenX;
    const quote = quoteIsX ? tokenX : quoteIsY ? tokenY : tokenY;
    const tvl = finite(raw?.tvl);
    const volume24h = finite(raw?.volume?.["24h"]);
    const lpFee24h = finite(raw?.fees?.["24h"]);
    const feeTvl = finite(raw?.fee_tvl_ratio?.["24h"])
      ?? (tvl !== null && tvl > 0 && lpFee24h !== null ? lpFee24h / tvl : null);
    const baseFeePct = finite(raw?.pool_config?.base_fee_pct);
    const dynamicFee = finite(raw?.dynamic_fee_pct);
    const baseFee = baseFeePct === null ? null : baseFeePct / 100;
    const feeTier = dynamicFee !== null && baseFee !== null && dynamicFee > baseFee ? dynamicFee : baseFee;
    const officialAprRaw = finite(raw?.apr);
    const pair = string(raw?.name)?.includes("-") ? raw.name.replaceAll("-", "/") : pairLabel(base, quote);
    return createPoolSchema({
      dex: "Meteora",
      poolType: "DLMM",
      poolAddress: string(raw?.address),
      programId: null,
      pair,
      baseMint: string(base?.address),
      quoteMint: string(quote?.address),
      baseSymbol: string(base?.symbol),
      quoteSymbol: string(quote?.symbol),
      tvl,
      volume24h,
      lpFee24h,
      feeTier,
      feeMode: dynamicFee !== null && baseFee !== null && dynamicFee > baseFee ? "DYNAMIC" : "BASE",
      feeApr24h: officialAprRaw,
      apr24h: officialAprRaw,
      volumeTvl: tvl !== null && tvl > 0 && volume24h !== null ? volume24h / tvl : null,
      feeTvl,
      currentPrice: finite(raw?.current_price),
      priceMin: null,
      priceMax: null,
      priceVolatilityPct: null,
      activeTimeHours: null,
      activeTimeSource: "官方 DLMM Pool 列表未提供逐小时活跃时长",
      tickSpacing: null,
      currentTick: null,
      binStep: finite(raw?.pool_config?.bin_step),
      isBlacklisted: raw?.is_blacklisted === true,
      tags: Array.isArray(raw?.tags) ? raw.tags : [],
      washVolumeStatus: "NOT_VERIFIED",
      source: "Meteora DLMM API",
      sourceRecord: raw,
      replayEvidence: raw?.replayEvidence ?? null,
    });
  }

  async discover() {
    const firstParams = new URLSearchParams({
      page: "1",
      page_size: String(this.pageSize),
      sort_by: "volume_24h:desc",
      filter_by: "is_blacklisted=false",
    });
    const first = await fetchJson(`${METEORA_URL}?${firstParams}`, this.fetchImpl);
    const pages = Math.max(1, Number(first?.pages) || 1);
    const pageCount = Math.min(pages, this.maxPages);
    const pageNumbers = Array.from({ length: pageCount - 1 }, (_, index) => index + 2);
    const rest = await mapWithConcurrency(pageNumbers, ADAPTER_LIMITS.apiConcurrency, (page) => {
      const params = new URLSearchParams({
        page: String(page),
        page_size: String(this.pageSize),
        sort_by: "volume_24h:desc",
        filter_by: "is_blacklisted=false",
      });
      return fetchJson(`${METEORA_URL}?${params}`, this.fetchImpl);
    });
    const pagesData = [first, ...rest];
    const pools = pagesData.flatMap((page) => Array.isArray(page?.data) ? page.data : []);
    return { dex: "Meteora", poolType: "DLMM", pools, total: finite(first?.total), pageCount, complete: pageCount >= pages, endpoint: METEORA_URL, pageSize: this.pageSize };
  }
}

export function normalizeScannerPools({ raydium = [], meteora = [] } = {}) {
  const raydiumAdapter = new RaydiumAdapter();
  const meteoraAdapter = new MeteoraAdapter();
  const rows = [...raydium.map((raw) => raydiumAdapter.normalize(raw)), ...meteora.map((raw) => meteoraAdapter.normalize(raw))];
  const seen = new Set();
  return rows.filter((row) => {
    if (!row.poolAddress || seen.has(`${row.dex}:${row.poolAddress}`)) return false;
    seen.add(`${row.dex}:${row.poolAddress}`);
    return true;
  });
}

export async function fetchScannerUniverse({ fetchImpl = fetch, limits = ADAPTER_LIMITS } = {}) {
  const results = await Promise.allSettled([
    new RaydiumAdapter({ fetchImpl, pageSize: limits.pageSize, maxPages: limits.maxRaydiumPages }).discover(),
    new MeteoraAdapter({ fetchImpl, pageSize: limits.pageSize, maxPages: limits.maxMeteoraPages }).discover(),
  ]);
  const raydium = results[0].status === "fulfilled" ? results[0].value : { pools: [], pageCount: 0, complete: false, endpoint: RAYDIUM_URL, error: results[0].reason?.message ?? "Raydium 数据源失败" };
  const meteora = results[1].status === "fulfilled" ? results[1].value : { pools: [], pageCount: 0, complete: false, endpoint: METEORA_URL, error: results[1].reason?.message ?? "Meteora 数据源失败" };
  return {
    pools: normalizeScannerPools({ raydium: raydium.pools, meteora: meteora.pools }),
    sources: {
      raydium: { dex: "Raydium", poolType: "CLMM", endpoint: raydium.endpoint, pageCount: raydium.pageCount, poolCount: raydium.pools.length, complete: raydium.complete, error: raydium.error ?? null },
      meteora: { dex: "Meteora", poolType: "DLMM", endpoint: meteora.endpoint, pageCount: meteora.pageCount, poolCount: meteora.pools.length, total: meteora.total ?? null, complete: meteora.complete, error: meteora.error ?? null },
    },
    complete: raydium.complete && meteora.complete,
  };
}

export const Raydium = Object.freeze({ name: "Raydium", poolType: "CLMM", source: RAYDIUM_URL });
export const Meteora = Object.freeze({ name: "Meteora", poolType: "DLMM", source: METEORA_URL });
