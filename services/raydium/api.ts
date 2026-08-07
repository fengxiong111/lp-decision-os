import type { ResearchUniverse, ServiceStatus, SourceRef } from "@/packages/models/src";
import { mapWithConcurrency, getJson } from "@/services/shared/http";
import {
  RAYDIUM_API_BASE,
  RAYDIUM_RWA_PAGE,
  RAYDIUM_PROGRAM_IDS,
  TOKEN_PROGRAM_IDS,
  USDC_MINT,
  poolKindFromProgram,
} from "@/services/raydium/config";
import { persistIndexerState, readIndexerState } from "@/services/storage/event-index";
import { evaluateResearchUniverse } from "@/services/indexer/universe";

type UnknownRecord = Record<string, unknown>;

export type RaydiumMint = {
  address: string;
  symbol: string;
  name: string;
  issuer: string | null;
  decimals: number | null;
  programId: string | null;
};

export type RaydiumPoolInfo = {
  id: string;
  programId: string;
  kind: "CLMM" | "CPMM" | "AMM v4";
  pooltype: string[];
  mintA: RaydiumMint;
  mintB: RaydiumMint;
  price: number | null;
  mintAmountA: number | null;
  mintAmountB: number | null;
  feeRate: number | null;
  isActive: boolean | null;
  identityConflict: string | null;
  openTime: string | null;
  tvl: number | null;
  day: {
    volume: number | null;
    volumeFee: number | null;
    apr: number | null;
    feeApr: number | null;
    priceMin: number | null;
    priceMax: number | null;
  };
  week: {
    volume: number | null;
    volumeFee: number | null;
    apr: number | null;
    feeApr: number | null;
  };
  config: {
    id: string | null;
    tradeFeeRate: number | null;
    tickSpacing: number | null;
    defaultRangePoint: number[];
  } | null;
  hasDynamicFee: boolean | null;
  raw: UnknownRecord;
};

export type RwaDiscoveryResult = {
  pools: RaydiumPoolInfo[];
  universe: ResearchUniverse;
  rwaAssetCount: number | null;
  candidatePoolCount: number;
  pairCount: number;
  apiStatus: ServiceStatus;
  apiLatencyMs: number | null;
  errors: string[];
  sources: SourceRef[];
};

let lastGoodDiscovery: RwaDiscoveryResult | null = null;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null;

const stringValue = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const numberValue = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const booleanValue = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

function explicitPoolActive(value: UnknownRecord): boolean | null {
  for (const key of ["tradeEnable", "tradingEnabled", "isOpen", "open", "active", "enable"]) {
    const candidate = value[key];
    if (typeof candidate === "boolean") return candidate;
  }
  const status = [value.status, value.state, value.poolState].find((candidate) => typeof candidate === "string");
  if (typeof status !== "string") return null;
  const normalized = status.toLowerCase();
  if (["active", "open", "enabled", "trading", "tradeable", "tradable"].some((word) => normalized.includes(word))) return true;
  if (["inactive", "closed", "disabled", "halted", "frozen", "paused"].some((word) => normalized.includes(word))) return false;
  return null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function source(label: string, url: string, observedAt: string, status: SourceRef["status"] = "live"): SourceRef {
  return { label, url, observedAt, status };
}

function parseMint(value: unknown): RaydiumMint | null {
  if (!isRecord(value)) return null;
  const address = stringValue(value.address);
  const extensions = isRecord(value.extensions) ? value.extensions : {};
  const tipValue = extensions.tips;
  const tips = Array.isArray(tipValue) ? tipValue : isRecord(tipValue) ? [tipValue] : [];
  const tipLinks = tips.flatMap((item) => isRecord(item) && typeof item.link === "string" ? [item.link] : []);
  const issuer = tipLinks.some((link) => link.includes("backed.fi"))
    ? "Backed Finance / xStocks"
    : tipLinks.some((link) => link.includes("backpack.exchange"))
      ? "Backpack Securities"
      : null;
  if (!address) return null;
  return {
    address,
    symbol: stringValue(value.symbol) ?? address.slice(0, 6),
    name: stringValue(value.name) ?? "未命名资产",
    issuer,
    decimals: numberValue(value.decimals),
    programId: stringValue(value.programId),
  };
}

function parsePool(value: unknown): RaydiumPoolInfo | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  const programId = stringValue(value.programId);
  const mintA = parseMint(value.mintA);
  const mintB = parseMint(value.mintB);
  const kind = programId ? poolKindFromProgram(programId) : null;
  if (!id || !programId || !mintA || !mintB || !kind || !RAYDIUM_PROGRAM_IDS.has(programId)) return null;

  const day = isRecord(value.day) ? value.day : {};
  const week = isRecord(value.week) ? value.week : {};
  const config = isRecord(value.config) ? value.config : null;
  const identityConflict = mintA.address === mintB.address
    ? "Pool 两侧 Mint 相同"
    : [mintA, mintB].some((mint) => mint.programId !== null && !TOKEN_PROGRAM_IDS.has(mint.programId))
      ? "Mint 使用了未核验的 Token Program"
      : null;

  return {
    id,
    programId,
    kind,
    pooltype: asArray(value.pooltype).filter((item): item is string => typeof item === "string"),
    mintA,
    mintB,
    price: numberValue(value.price),
    mintAmountA: numberValue(value.mintAmountA),
    mintAmountB: numberValue(value.mintAmountB),
    feeRate: numberValue(value.feeRate),
    isActive: explicitPoolActive(value),
    identityConflict,
    openTime: stringValue(value.openTime),
    tvl: numberValue(value.tvl),
    day: {
      volume: numberValue(day.volume),
      volumeFee: numberValue(day.volumeFee),
      apr: numberValue(day.apr),
      feeApr: numberValue(day.feeApr),
      priceMin: numberValue(day.priceMin),
      priceMax: numberValue(day.priceMax),
    },
    week: {
      volume: numberValue(week.volume),
      volumeFee: numberValue(week.volumeFee),
      apr: numberValue(week.apr),
      feeApr: numberValue(week.feeApr),
    },
    config: config
      ? {
          id: stringValue(config.id),
          tradeFeeRate: numberValue(config.tradeFeeRate),
          tickSpacing: numberValue(config.tickSpacing),
          defaultRangePoint: asArray(config.defaultRangePoint).flatMap((item) => {
            const value = numberValue(item);
            return value === null ? [] : [value];
          }),
        }
      : null,
    hasDynamicFee: booleanValue(value.hasDynamicFee),
    raw: value,
  };
}

function getRows(value: unknown): UnknownRecord[] {
  if (!isRecord(value) || !isRecord(value.data)) return [];
  return asArray(value.data.data).filter(isRecord);
}

function getMintFilterCount(value: unknown): number | null {
  if (!isRecord(value) || !isRecord(value.data)) return null;
  const rows = asArray(value.data.row);
  const rwa = rows.find((row) => isRecord(row) && row.name === "RWA");
  return isRecord(rwa) ? numberValue(rwa.count) : null;
}

function isRwaUsdcPool(pool: RaydiumPoolInfo): boolean {
  return (
    pool.pooltype.includes("RWA") &&
    ((pool.mintA.address === USDC_MINT && pool.mintB.address !== USDC_MINT) ||
      (pool.mintB.address === USDC_MINT && pool.mintA.address !== USDC_MINT))
  );
}

async function fetchPoolsByMint(mint: string): Promise<{ pools: RaydiumPoolInfo[]; error: string | null; latencyMs: number | null }> {
  const url = `${RAYDIUM_API_BASE}/pools/info/mint?mint1=${encodeURIComponent(mint)}&mint2=${encodeURIComponent(USDC_MINT)}&poolType=all&poolSortField=liquidity&sortType=desc&pageSize=1000&page=1`;
  const response = await getJson<unknown>(url, 10_000);
  const pools = getRows(response.data).map(parsePool).filter((pool): pool is RaydiumPoolInfo => pool !== null && isRwaUsdcPool(pool));
  return { pools, error: response.meta.error, latencyMs: response.meta.latencyMs };
}

export async function discoverRwaUsdcPools(): Promise<RwaDiscoveryResult> {
  const observedAt = new Date().toISOString();
  const filterUrl = `${RAYDIUM_API_BASE}/main/mint-filter-config`;
  const listUrl = `${RAYDIUM_API_BASE}/pools/info/list-v2?size=1000&hasReward=false&sortField=liquidity&sortType=desc&mintFilter=RWA`;
  const [filterResponse, listResponse] = await Promise.all([
    getJson<unknown>(filterUrl, 8_000),
    getJson<unknown>(listUrl, 12_000),
  ]);

  const errors: string[] = [];
  if (filterResponse.meta.error) errors.push(`RWA 配置：${filterResponse.meta.error}`);
  if (listResponse.meta.error) errors.push(`RWA 池发现：${listResponse.meta.error}`);

  const listPools = getRows(listResponse.data).map(parsePool).filter((pool): pool is RaydiumPoolInfo => pool !== null);
  const candidatePools = listPools.filter(isRwaUsdcPool);
  // list-v2 is the public market source. Mint-by-mint calls are retained only as a
  // recovery path when the list endpoint itself returns no usable RWA pool.
  const candidateMints = [...new Set(candidatePools.map((pool) => (pool.mintA.address === USDC_MINT ? pool.mintB.address : pool.mintA.address)))];
  const mintResults = candidatePools.length === 0 && candidateMints.length > 0
    ? await mapWithConcurrency(candidateMints, 8, fetchPoolsByMint)
    : [];

  const uniquePools = new Map<string, RaydiumPoolInfo>();
  for (const pool of candidatePools) uniquePools.set(pool.id, pool);
  for (const result of mintResults) {
    if (result.error) errors.push(`Mint 复核：${result.error}`);
    for (const pool of result.pools) uniquePools.set(pool.id, pool);
  }

  const pools = [...uniquePools.values()].sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0));
  const universe = evaluateResearchUniverse(pools, new Date(observedAt));
  const pairCount = new Set(
    pools.map((pool) => (pool.mintA.address === USDC_MINT ? pool.mintB.address : pool.mintA.address)),
  ).size;
  const hasList = listResponse.data !== null;
  const hasPublicPools = pools.length > 0;
  const apiStatus: ServiceStatus = hasPublicPools ? (errors.length > 0 ? "降级" : "在线") : hasList ? "降级" : "离线";
  const apiLatencyMs = Math.max(listResponse.meta.latencyMs ?? 0, filterResponse.meta.latencyMs ?? 0);

  const result: RwaDiscoveryResult = {
    pools,
    universe,
    rwaAssetCount: getMintFilterCount(filterResponse.data),
    candidatePoolCount: candidatePools.length,
    pairCount,
    apiStatus,
    apiLatencyMs,
    errors: errors.slice(0, 6),
    sources: [
      source("Raydium RWA 页面", RAYDIUM_RWA_PAGE, observedAt),
      source("Raydium RWA 配置", filterUrl, observedAt),
      source("Raydium RWA 池发现", listUrl, observedAt),
      source("Raydium v3 Mint 复核", `${RAYDIUM_API_BASE}/pools/info/mint`, observedAt),
    ],
  };
  if (result.pools.length > 0) {
    lastGoodDiscovery = result;
    persistIndexerState("last_known_good_discovery", result);
    return result;
  }
  if (lastGoodDiscovery) {
    return {
      ...lastGoodDiscovery,
      // A stale API snapshot is not a fresh TVL observation. Do not age a pool
      // out of the research Universe merely because the public source is down.
      universe: lastGoodDiscovery.universe,
      apiStatus: "降级",
      apiLatencyMs,
      errors: [...new Set([...errors, "Raydium API 暂时不可用，继续展示最近一次公开市场快照"])].slice(0, 6),
    };
  }
  const persisted = readIndexerState<RwaDiscoveryResult>("last_known_good_discovery");
  if (persisted?.pools?.length) {
    lastGoodDiscovery = persisted;
    return {
      ...persisted,
      universe: persisted.universe ?? evaluateResearchUniverse(persisted.pools, new Date(observedAt)),
      apiStatus: "降级",
      apiLatencyMs,
      errors: [...new Set([...errors, "Raydium API 暂时不可用，继续展示 SQLite 最近一次公开市场快照"])].slice(0, 6),
    };
  }
  return { ...result, universe };
}
