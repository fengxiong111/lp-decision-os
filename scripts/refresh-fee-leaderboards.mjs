import { readFile, rename, writeFile } from "node:fs/promises";
import { DASHBOARD_CONFIG } from "./mobile-dashboard/config.mjs";
import { snapshotHash } from "./mobile-dashboard/evidence.mjs";
import { normalizePools } from "./mobile-dashboard/market-data.mjs";
import { fetchRaydiumPools } from "./mobile-dashboard/source.mjs";
import { fetchFeeLeaderboards } from "./mobile-dashboard/fee-leaderboards.mjs";

const outputDir = new URL("../mobile-dashboard/", import.meta.url);
const snapshotUrl = new URL("top3.json", outputDir);
const current = JSON.parse(await readFile(snapshotUrl, "utf8"));
const rawPools = await fetchRaydiumPools(DASHBOARD_CONFIG);
const rwaPools = normalizePools(rawPools, DASHBOARD_CONFIG);
const feeLeaderboards = await fetchFeeLeaderboards({ rwaPools });
const nextBase = {
  ...current,
  feeLeaderboards,
  feeLeaderboardsGeneratedAt: feeLeaderboards.generatedAt,
  rwaMints: [...new Set(rwaPools.map((pool) => pool.assetMint).filter(Boolean))],
  opportunityRanking: {
    ...current.opportunityRanking,
    feeLeaderboardCount: feeLeaderboards.overall.length,
    rwaFeeLeaderboardCount: feeLeaderboards.rwa.length,
  },
};
const next = { ...nextBase, snapshotHash: snapshotHash(nextBase) };
const nextUrl = new URL("top3-next.json", outputDir);
await writeFile(nextUrl, JSON.stringify(next, null, 2));
await rename(nextUrl, snapshotUrl);

console.log(JSON.stringify({
  status: "PASS",
  source: "Raydium API v3 + Meteora DLMM API",
  overallCount: feeLeaderboards.overall.length,
  rwaCount: feeLeaderboards.rwa.length,
  snapshotHash: next.snapshotHash,
  generatedAt: feeLeaderboards.generatedAt,
}, null, 2));
