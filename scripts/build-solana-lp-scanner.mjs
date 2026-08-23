import { rename, writeFile } from "node:fs/promises";
import { DASHBOARD_CONFIG } from "./mobile-dashboard/config.mjs";
import { snapshotHash } from "./mobile-dashboard/evidence.mjs";
import { buildScannerCandidates, fetchScannerUniverse, SCANNER_FILTERS, SCANNER_LIMITS } from "./mobile-dashboard/scanner.mjs";
import { verifyScannerSnapshot } from "./mobile-dashboard/verify.mjs";

const fetchedAt = new Date().toISOString();
const universe = await fetchScannerUniverse();
const scanner = buildScannerCandidates(universe.pools, {
  filters: SCANNER_FILTERS,
  capital: DASHBOARD_CONFIG.capital,
  limit: SCANNER_LIMITS.top10,
});
const snapshotBase = {
  schemaVersion: 2,
  product: "Solana LP Opportunity Scanner",
  generatedAt: fetchedAt,
  sourceEvidence: {
    primary: "Official Raydium API v3 + Meteora DLMM API",
    fetchedAt,
    sources: universe.sources,
    complete: universe.complete,
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
    allPoolCount: scanner.allPoolCount,
    eligiblePoolCount: scanner.eligiblePoolCount,
    excludedPoolCount: scanner.excludedPoolCount,
    excludedByReason: scanner.excludedByReason,
    rankingBasis: scanner.rankingBasis,
    top10Count: scanner.candidates.length,
    defaultDisplayLimit: SCANNER_LIMITS.display,
    filters: SCANNER_FILTERS,
    candidates: scanner.candidates,
  },
};
const snapshot = { ...snapshotBase, snapshotHash: snapshotHash(snapshotBase) };
verifyScannerSnapshot(snapshot, DASHBOARD_CONFIG);

const outputDir = new URL("../mobile-dashboard/", import.meta.url);
const nextUrl = new URL("top3-next.json", outputDir);
const currentUrl = new URL("top3.json", outputDir);
await writeFile(nextUrl, JSON.stringify(snapshot, null, 2));
await rename(nextUrl, currentUrl);

console.log(JSON.stringify({
  status: "PASS",
  product: snapshot.product,
  scanner: {
    allPoolCount: scanner.allPoolCount,
    eligiblePoolCount: scanner.eligiblePoolCount,
    top10Count: scanner.candidates.length,
    defaultDisplayLimit: SCANNER_LIMITS.display,
    rankingBasis: scanner.rankingBasis,
  },
  sources: universe.sources,
  snapshotHash: snapshot.snapshotHash,
  generatedAt: fetchedAt,
}, null, 2));
