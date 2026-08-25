import { readFile, rename, writeFile } from "node:fs/promises";
import { snapshotHash } from "./mobile-dashboard/evidence.mjs";
import { DASHBOARD_CONFIG } from "./mobile-dashboard/config.mjs";
import { fetchScannerUniverse } from "./mobile-dashboard/adapters.mjs";
import { evaluateScannerFilter, SCANNER_FILTERS } from "./mobile-dashboard/market-scanner.mjs";

const outputDir = new URL("../mobile-dashboard/", import.meta.url);
const currentUrl = new URL("top3.json", outputDir);
const fetchedAt = new Date().toISOString();

let previous = null;
try {
  previous = JSON.parse(await readFile(currentUrl, "utf8"));
} catch {
  // The first successful official refresh does not require a prior snapshot.
}

const universe = await fetchScannerUniverse();
if (!universe.complete) {
  throw new Error("Raydium/Meteora 官方市场源未完整返回，本次刷新已停止，避免发布部分快照");
}
if (universe.pools.length === 0) {
  throw new Error("官方市场源返回 0 个 Pool，本次刷新已停止，避免清空现有市场数据");
}

const evaluations = universe.pools.map((pool) => ({ pool, filter: evaluateScannerFilter(pool, SCANNER_FILTERS) }));
const eligible = evaluations.filter(({ filter }) => filter.eligible);
const excludedByReason = evaluations.flatMap(({ filter }) => filter.reasons).reduce((counts, reason) => {
  counts[reason] = (counts[reason] ?? 0) + 1;
  return counts;
}, {});
const candidates = eligible
  .map(({ pool, filter }) => ({
    poolSchemaVersion: pool.schemaVersion,
    poolAddress: pool.poolAddress,
    pair: pool.pair,
    dex: pool.dex,
    poolType: pool.poolType,
    programId: pool.programId,
    baseMint: pool.baseMint,
    quoteMint: pool.quoteMint,
    tvl: pool.tvl,
    volume24h: pool.volume24h,
    lpFee24h: pool.lpFee24h,
    feeTier: pool.feeTier,
    feeApr24h: pool.feeApr24h,
    apr24h: pool.apr24h,
    volumeTvl: pool.volumeTvl,
    feeTvl: pool.feeTvl,
    currentPrice: pool.currentPrice,
    priceVolatilityPct: pool.priceVolatilityPct,
    activeTimeHours: pool.activeTimeHours,
    activeTimeSource: pool.activeTimeSource,
    washVolumeStatus: pool.washVolumeStatus,
    filter,
    source: pool.source,
  }))
  .sort((left, right) => (right.lpFee24h ?? -Infinity) - (left.lpFee24h ?? -Infinity)
    || String(left.pair).localeCompare(String(right.pair))
    || String(left.poolAddress).localeCompare(String(right.poolAddress)))
  .slice(0, 50)
  .map((candidate, index) => ({ ...candidate, rank: index + 1 }));

const snapshotBase = {
  schemaVersion: 2,
  product: "Solana LP Decision OS",
  generatedAt: fetchedAt,
  sourceEvidence: {
    primary: "Official Raydium API v3 + Meteora DLMM API",
    fetchedAt,
    sources: universe.sources,
    complete: universe.complete,
    replay: {
      status: "UNCHANGED",
      source: "MARKET_ONLY_REFRESH",
      reason: "深度 Replay 不在市场快照刷新路径中",
      previousGeneratedAt: previous?.generatedAt ?? null,
    },
    replayQueue: [],
  },
  scope: {
    protocols: ["Raydium", "Meteora"],
    poolTypes: ["CLMM", "DLMM"],
    capital: DASHBOARD_CONFIG.capital,
    shadowPosition: true,
    walletDependency: false,
    autoExecution: false,
  },
  scanner: {
    version: 1,
    generatedAt: fetchedAt,
    allPoolCount: universe.pools.length,
    eligiblePoolCount: eligible.length,
    excludedPoolCount: evaluations.length - eligible.length,
    excludedByReason,
    rankingBasis: "MARKET_RADAR_PREVIEW",
    marketLimit: 50,
    replayLimit: 10,
    verificationLimit: 3,
    top50Count: candidates.length,
    top10Count: Math.min(candidates.length, 10),
    defaultDisplayLimit: 5,
    filters: SCANNER_FILTERS,
    candidates,
  },
};
const snapshot = { ...snapshotBase, snapshotHash: snapshotHash(snapshotBase) };
const nextUrl = new URL("top3-next.json", outputDir);
await writeFile(nextUrl, JSON.stringify(snapshot, null, 2));
await rename(nextUrl, currentUrl);

console.log(JSON.stringify({
  status: "PASS",
  source: "Official Raydium API v3 + Meteora DLMM API",
  fetchedAt,
  allPoolCount: universe.pools.length,
  eligiblePoolCount: eligible.length,
  candidateCount: candidates.length,
  snapshotHash: snapshot.snapshotHash,
}, null, 2));
