import { createHash } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { DASHBOARD_CONFIG } from "./mobile-dashboard/config.mjs";
import { displayAction, renderPage } from "./mobile-dashboard/presentation.mjs";
import { formatTimestamp } from "./mobile-dashboard/format.mjs";
import { normalizePools } from "./mobile-dashboard/market-data.mjs";
import { collectProductionEvidence, snapshotFreshness, snapshotHash } from "./mobile-dashboard/evidence.mjs";
import { buildOptimizerResults } from "./mobile-dashboard/optimizer.mjs";
import { buildDiagnosticReport, deriveVolatilityRegime, statusForTop3 } from "./mobile-dashboard/diagnostics.mjs";
import { renderRuntime } from "./mobile-dashboard/runtime.mjs";
import { fetchRaydiumPools } from "./mobile-dashboard/source.mjs";
import { verifyDataJson, verifyMarketData, verifyPageMarkup, verifySnapshot } from "./mobile-dashboard/verify.mjs";

const fetchedAt = new Date().toISOString();
const rawPools = await fetchRaydiumPools(DASHBOARD_CONFIG);
const apiPools = normalizePools(rawPools, DASHBOARD_CONFIG);
const evidenceRun = await collectProductionEvidence(apiPools, DASHBOARD_CONFIG);
const pools = evidenceRun.pools.map((pool) => ({
  ...pool,
  volatilityRegime: deriveVolatilityRegime(pool),
}));
const optimizerSummary = buildOptimizerResults(pools, DASHBOARD_CONFIG);
const updatedAt = formatTimestamp(fetchedAt);
if (!updatedAt) throw new Error("Could not produce a valid observation timestamp");

verifyMarketData(pools, optimizerSummary, DASHBOARD_CONFIG);

const blockersByPool = optimizerSummary.results.map(({ pool, optimizer }) => ({
  poolAddress: pool.poolAddress,
  pair: `${pool.symbol}/USDC`,
  universeStatus: pool.universeStatus,
  executable: optimizer.executable,
  blockers: [...new Set([...(optimizer.blockers ?? []), ...(pool.evidence?.blockers ?? [])])],
  dataFreshness: pool.evidence?.dataFreshness ?? null,
}));
const blockerMatrix = optimizerSummary.results
  .filter(({ pool }) => pool.evidence)
  .map(({ pool, optimizer }) => {
    const evidence = pool.evidence;
    const window24 = evidence.swaps?.windows?.["24"] ?? null;
    const path = evidence.swaps?.path ?? null;
    const shadow = evidence.shadowReplay ?? null;
    return {
      pool: pool.poolAddress,
      pair: `${pool.symbol}/USDC`,
      coverage24h: {
        status: window24?.windowComplete === true ? "PASS" : "INCOMPLETE",
        coverageRatio: window24?.coverageRatio ?? null,
        expectedBucketCount: window24?.expectedBucketCount ?? null,
        metricsBucketCount: window24?.metricsBucketCount ?? null,
        gapCount: window24?.gapCount ?? null,
        unknownInstructions: window24?.unknownInstructions ?? null,
        unresolvedRetryableTransactions: window24?.unresolvedRetryableTransactions ?? null,
        firstEventTime: window24?.firstEventTime ?? null,
        lastEventTime: window24?.lastEventTime ?? null,
        replayCoverageSeconds: window24?.replayCoverageSeconds ?? null,
        totalSwaps: window24?.totalSwaps ?? null,
        validSwaps: window24?.validSwaps ?? null,
        invalidSwaps: window24?.invalidSwaps ?? null,
        pathCoverage: window24?.pathCoverage ?? null,
        feeCoverage: window24?.feeCoverage ?? null,
      },
      swapPath: {
        status: path?.coverageRatio === 1 && path?.divergence !== true && path?.transactionOrderComplete === true && path?.stateContinuityPass !== false ? "PASS" : "INCOMPLETE",
        valid: path?.valid ?? null,
        total: path?.total ?? null,
        coverageRatio: path?.coverageRatio ?? null,
        divergence: path?.divergence ?? null,
        currentMatchesLast: path?.currentMatchesLast ?? null,
        currentStateAfterReplay: path?.currentStateAfterReplay ?? null,
        transactionOrderComplete: path?.transactionOrderComplete ?? null,
        orderIncompleteSlots: path?.orderIncompleteSlots ?? [],
      },
      fee: {
        status: evidence.feeConfigVerified === true && (evidence.swaps?.parser?.amountReconciliationFailed ?? 1) === 0 ? "PASS" : "INCOMPLETE",
        parsedSwap: evidence.swaps?.parser?.parsedSwap ?? null,
        reconciliationFailed: evidence.swaps?.parser?.amountReconciliationFailed ?? null,
        feeGrowthReconciliation: evidence.feeGrowthReconciliation?.status ?? "UNAVAILABLE",
        replayFeeUsd: evidence.feeGrowthReconciliation?.replayFeeUsd ?? null,
        feeGrowthExpected: evidence.feeGrowthReconciliation?.feeGrowthExpected ?? null,
        diffBps: evidence.feeGrowthReconciliation?.diffBps ?? null,
        evidence: "OFFICIAL_SWAP_EVENT_PLUS_CONFIG_SPLIT",
      },
      activeLiquidityReplay: {
        status: shadow?.status === "SHADOW_FEE_REPLAY_COMPLETE_NET_PENDING" ? "PASS" : "INCOMPLETE",
        candidateCount: shadow?.candidateCount ?? 0,
        method: shadow?.feeAllocationMethod ?? null,
        blockers: shadow?.blockers ?? [],
      },
      replay: {
        status: evidence.replayEvidence ? "PARTIAL_OR_COMPLETE" : "UNAVAILABLE",
        blockers: evidence.replayEvidence?.blockers ?? (evidence.blockers ?? []),
        executionCostQuality: evidence.replayEvidence?.executionCostQuality ?? null,
        markoutQuality: evidence.replayEvidence?.markoutQuality ?? null,
      },
      cost: {
        status: evidence.executionCostEvidence?.quality ?? "UNAVAILABLE",
        simulation: evidence.executionCostEvidence?.simulation ?? null,
      },
      markout: {
        status: evidence.markout?.quality ?? "INCOMPLETE",
        source: evidence.markout?.source ?? null,
      },
      executable: optimizer.executable === true,
    };
  });
const blockerMatrixByPool = new Map(blockerMatrix.map((row) => [row.pool, row]));
const diagnostics = buildDiagnosticReport(optimizerSummary.results, blockerMatrixByPool);
const diagnosticByPool = new Map(diagnostics.matrix.map((row) => [row.poolAddress, row]));
const top3ForPage = optimizerSummary.top3
  .filter((row) => statusForTop3(diagnosticByPool.get(row.poolAddress)))
  .slice(0, 3)
  .map((row, index) => ({
    rank: index + 1,
    pair: `${row.symbol}/USDC`,
    poolAddress: row.poolAddress,
    net24h: row.best?.expectedNetFee24h ?? null,
    coreCapital: row.best?.coreCapital ?? null,
    coreLower: row.best?.core?.lowerPrice ?? null,
    coreUpper: row.best?.core?.upperPrice ?? null,
    bufferCapital: row.best?.bufferCapital ?? null,
    bufferLower: row.best?.buffer?.lowerPrice ?? null,
    bufferUpper: row.best?.buffer?.upperPrice ?? null,
    action: displayAction(row.action),
    status: diagnosticByPool.get(row.poolAddress)?.status ?? "UNAVAILABLE",
    dataQuality: row.dataQuality ?? null,
    evidence: row.evidence ?? null,
  }));
const slot = pools.reduce((highest, pool) => {
  const candidate = Number(pool.evidence?.poolState?.slot);
  return Number.isFinite(candidate) ? Math.max(highest ?? candidate, candidate) : highest;
}, null);
const baseSnapshot = {
  schemaVersion: 1,
  generatedAt: fetchedAt,
  slot,
  dataFreshness: snapshotFreshness(fetchedAt, DASHBOARD_CONFIG.evidence.freshnessSlaMs),
  strategyVersion: "shadow-v1",
  snapshotType: "VERIFIED_RAYDIUM_RWA_USDC_EVIDENCE",
  sourceEvidence: {
    api: { provider: "Raydium API v3", url: DASHBOARD_CONFIG.apiUrl, fetchedAt },
    rpc: { urls: DASHBOARD_CONFIG.rpcUrls, methodLimits: { globalRps: 6, getTransactionRps: 3, getSignaturesForAddressRps: 1, maxConcurrency: 6 } },
    layer: evidenceRun.evidenceSummary.activeIndexedCount > 0 ? "API_METADATA_PLUS_ONCHAIN_EVIDENCE" : "API_METADATA_ONLY",
    evidenceSummary: evidenceRun.evidenceSummary,
  },
  scope: {
    protocol: "Raydium",
    universe: "RWA / USDC",
    status: "ACTIVE_INDEXED_REQUIRED",
    capital: DASHBOARD_CONFIG.capital,
    tvlEnterThreshold: DASHBOARD_CONFIG.tvlEnterThreshold,
    tvlExitHysteresis: DASHBOARD_CONFIG.tvlExitHysteresis,
    objective: "EXPECTED_NET_FEE_24H_USD_1000",
    autoExecution: DASHBOARD_CONFIG.autoExecution,
    displayLimit: 3,
  },
  publicPoolCount: pools.length,
  stage1CandidateCount: evidenceRun.evidenceSummary.stage1CandidateCount,
  activeIndexedPoolCount: evidenceRun.evidenceSummary.activeIndexedCount,
  executablePoolCount: diagnostics.readyCount,
  optimizerExecutablePoolCount: optimizerSummary.executablePoolCount,
  nearReadyPoolCount: diagnostics.nearReadyCount,
  blockedPoolCount: diagnostics.blockedCount,
  shadowState: optimizerSummary.shadowState,
  top3Change: { ...optimizerSummary.top3Change, readyOnly: true },
  top3: top3ForPage,
  diagnostics,
  blockersByPool,
  blockerMatrix,
  optimizerAudit: {
    blockedPoolCount: diagnostics.blockedCount,
    nearReadyPoolCount: diagnostics.nearReadyCount,
    completeEvidencePoolCount: diagnostics.readyCount,
    optimizerExecutablePoolCount: optimizerSummary.executablePoolCount,
    noWallet: true,
    noRealPosition: true,
    autoExecution: false,
  },
};
const snapshot = { ...baseSnapshot, snapshotHash: snapshotHash(baseSnapshot) };
const data = JSON.stringify(snapshot, null, 2);
verifySnapshot(snapshot, DASHBOARD_CONFIG);
verifyDataJson(data);

const runtime = renderRuntime(DASHBOARD_CONFIG);
const runtimeVersion = createHash("sha256").update(runtime).digest("hex");
const page = renderPage({ optimizerSummary, evidenceSummary: evidenceRun.evidenceSummary, fetchedAt, poolCount: pools.length, snapshotHash: snapshot.snapshotHash, runtimeVersion, config: DASHBOARD_CONFIG });
verifyPageMarkup(page);

const outputDir = new URL("../mobile-dashboard/", import.meta.url);
await mkdir(outputDir, { recursive: true });
await writeFile(new URL("index.html", outputDir), page);
await writeFile(new URL("runtime.js", outputDir), runtime);
for (const legacyFile of ["data.json", "top3-next.json"]) {
  try {
    await unlink(new URL(legacyFile, outputDir));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
const nextSnapshot = new URL("top3-next.json", outputDir);
const currentSnapshot = new URL("top3.json", outputDir);
await writeFile(nextSnapshot, data);
await rename(nextSnapshot, currentSnapshot);
const manifest = {
  schemaVersion: 1,
  sourceDirectory: "mobile-dashboard",
  top3Json: "mobile-dashboard/top3.json",
  indexHtml: "mobile-dashboard/index.html",
  runtimeJs: "mobile-dashboard/runtime.js",
  pageDataSource: "./top3.json",
  top3Count: top3ForPage.length,
  snapshotHash: snapshot.snapshotHash,
  generatedAt: fetchedAt,
  legacyColumnsPresent: false,
  staleFallbackRemoved: true,
  serviceWorker: false,
};
await writeFile(new URL("deployment-manifest.json", outputDir), JSON.stringify(manifest, null, 2));

console.log(JSON.stringify({
  updatedAt,
  publicPoolCount: pools.length,
  stage1CandidateCount: evidenceRun.evidenceSummary.stage1CandidateCount,
  activeIndexedPoolCount: evidenceRun.evidenceSummary.activeIndexedCount,
  executablePoolCount: optimizerSummary.executablePoolCount,
  top3: top3ForPage.map((row) => ({ rank: row.rank, pair: row.pair, action: row.action })),
  rpc: evidenceRun.evidenceSummary.rpc,
  status: top3ForPage.length > 0 ? "RWA_TOP3_PRODUCTION_EVIDENCE_READY_CANDIDATE" : "UNAVAILABLE_REAL_EVIDENCE_INCOMPLETE",
}, null, 2));
