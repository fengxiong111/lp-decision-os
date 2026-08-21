import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import { DASHBOARD_CONFIG } from "../scripts/mobile-dashboard/config.mjs";
import { formatTimestamp } from "../scripts/mobile-dashboard/format.mjs";
import { normalizePools } from "../scripts/mobile-dashboard/market-data.mjs";
import {
  buildOptimizerResults,
  buildStrategyCandidates,
  searchOptimizer,
  snapRange,
  snapTick,
} from "../scripts/mobile-dashboard/optimizer.mjs";
import { renderPage } from "../scripts/mobile-dashboard/presentation.mjs";
import { renderRuntime } from "../scripts/mobile-dashboard/runtime.mjs";
import { decodeSwapEventLog, snapshotFreshness, snapshotHash } from "../scripts/mobile-dashboard/evidence.mjs";
import { buildDiagnosticReport, buildPoolDiagnostic, deriveVolatilityRegime, statusForTop3 } from "../scripts/mobile-dashboard/diagnostics.mjs";
import { buildOpportunityRanking } from "../scripts/mobile-dashboard/opportunity.mjs";
import { verifyDataJson, verifyMarketData, verifyPageMarkup, verifySnapshot } from "../scripts/mobile-dashboard/verify.mjs";

function rawPool({
  id = "pool-a",
  assetAddress = "asset-a",
  symbol = "AAA",
  name = "Alpha Stock",
  tvl = 10_000,
  volume = 2_000,
  fee = 100,
  feeRate = 0.0025,
  price = 2,
  universeStatus = "ACTIVE_INDEXED",
  currentTick = 100_000,
  activeLiquidity = 1_000_000,
  replayEvidence = null,
  shadowPosition = null,
} = {}) {
  return {
    id,
    programId: "raydium-clmm-program",
    pooltype: ["RWA", "Clmm"],
    universeStatus,
    mintA: { address: DASHBOARD_CONFIG.usdcMint, decimals: 6, symbol: "USDC" },
    mintB: { address: assetAddress, decimals: 8, symbol, name },
    price,
    currentTick,
    activeLiquidity,
    tvl,
    feeRate,
    hasDynamicFee: false,
    config: { tickSpacing: 10, tradeFeeRate: 0.0025 },
    day: { volume, volumeFee: fee },
    replayEvidence,
    executionCosts: { totalRebalanceCost: 0.12, safetyMargin: 0.08 },
    shadowPosition,
  };
}

function replayEvidence() {
  return {
    candidates: Object.fromEntries(buildStrategyCandidates(DASHBOARD_CONFIG).map((candidate, index) => [candidate.id, {
      coreActiveTimeRatio: 0.9,
      bufferActiveTimeRatio: 0.98,
      coreCapturedFee: 7 + index / 100,
      bufferCapturedFee: 5,
      selfDilution: 0.2,
      rebalanceFrequency: 1,
      rebalanceSwapCost: 0.1,
      slippage: 0.05,
      transactionCost: 0.03,
      inventoryChange: 0.01,
      impermanentLoss: 0.15,
      toxicMarkout: 0.2,
    }])),
  };
}

test("策略搜索固定为 $1,000，枚举合法 Core + Buffer + Allocation", () => {
  const candidates = buildStrategyCandidates(DASHBOARD_CONFIG);
  assert.equal(DASHBOARD_CONFIG.capital, 1_000);
  assert.equal(candidates.length, 87);
  assert.ok(candidates.every((candidate) => candidate.bufferWidth > candidate.coreWidth));
  assert.ok(candidates.every((candidate) => candidate.coreCapital + candidate.bufferCapital === 1_000));
  assert.equal(snapTick(101, 10, "down"), 100);
  assert.equal(snapTick(101, 10, "up"), 110);
});

test("官方 Raydium CLMM SwapEvent 按 discriminator 与字段宽度解码", () => {
  const data = Buffer.alloc(221);
  Buffer.from("40c6cde8260871e2", "hex").copy(data, 0);
  const pubkeys = [
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "11111111111111111111111111111111",
    "So11111111111111111111111111111111111111112",
    "SysvarRent111111111111111111111111111111111",
  ];
  let offset = 8;
  for (const value of pubkeys) {
    const bytes = new PublicKey(value).toBuffer();
    bytes.copy(data, offset);
    offset += 32;
  }
  data.writeBigUInt64LE(1_000n, offset); offset += 8;
  data.writeBigUInt64LE(0n, offset); offset += 8;
  data.writeBigUInt64LE(2_000n, offset); offset += 8;
  data.writeBigUInt64LE(3n, offset); offset += 8;
  data[offset] = 1; offset += 1;
  for (let index = 0; index < 16; index += 1) data[offset + index] = index === 0 ? 0x00 : 0x10;
  offset += 16;
  for (let index = 0; index < 16; index += 1) data[offset + index] = index === 0 ? 0x00 : 0x20;
  offset += 16;
  data.writeInt32LE(-123, offset); offset += 4;
  data.writeBigUInt64LE(25n, offset); offset += 8;
  data.writeBigUInt64LE(0n, offset);
  const decoded = decodeSwapEventLog(`Program data: ${data.toString("base64")}`);
  assert.equal(decoded.poolState, pubkeys[0]);
  assert.equal(decoded.amount0Atomic, "1000");
  assert.equal(decoded.amount1Atomic, "2000");
  assert.equal(decoded.zeroForOne, true);
  assert.equal(decoded.tick, -123);
  assert.equal(decoded.tradeFee0Atomic, "25");
  assert.equal(decodeSwapEventLog(`Program data: ${data.subarray(0, 220).toString("base64")}`), null);
});

test("完整真实证据才产生可执行结果，且没有钱包/真实仓位依赖", () => {
  const [pool] = normalizePools([rawPool({ replayEvidence: replayEvidence() })], DASHBOARD_CONFIG);
  const result = searchOptimizer(pool, DASHBOARD_CONFIG);
  assert.equal(result.executable, true);
  assert.equal(result.action, "OPEN");
  assert.equal(result.candidatesSearched, 87);
  assert.equal(result.candidatesEvaluated, 87);
  assert.equal(result.validation.walletDependencyRemoved, "PASS");
  assert.equal(result.validation.realPositionDependencyRemoved, "PASS");
  assert.equal(result.validation.autoExecution, "OFF");
  assert.ok(result.best.expectedNetFee24h > 0);
  assert.ok(snapRange({ width: 0.01 }, pool).tickLower % pool.tickSpacing === 0);
});

test("官方 API 缺少链上回放证据时 fail-closed，不生成 Top 3", () => {
  const pools = normalizePools([
    rawPool({ id: "pool-a", assetAddress: "asset-a", symbol: "AAA" }),
    rawPool({ id: "pool-b", assetAddress: "asset-b", symbol: "BBB", currentTick: null, universeStatus: null }),
  ], DASHBOARD_CONFIG);
  const summary = buildOptimizerResults(pools, DASHBOARD_CONFIG);
  assert.equal(summary.top3.length, 0);
  assert.equal(summary.executablePoolCount, 0);
  assert.equal(summary.results[0].optimizer.action, "UNAVAILABLE");
  assert.ok(summary.results[0].optimizer.blockers.includes("SWAP_HISTORY_UNAVAILABLE"));
  assert.ok(summary.results[1].optimizer.blockers.includes("CURRENT_TICK_UNAVAILABLE"));
});

test("影子仓位只影响动作，不读取钱包；排序跌出 Top 3 不自动 CLOSE", () => {
  const shadowPosition = {
    hasPosition: true,
    existingExpectedNetFee24h: 8,
    coreHealthy: false,
    bufferHealthy: true,
  };
  const [pool] = normalizePools([rawPool({ replayEvidence: replayEvidence(), shadowPosition })], DASHBOARD_CONFIG);
  const result = searchOptimizer(pool, DASHBOARD_CONFIG);
  assert.equal(result.action, "MOVE_CORE");
  assert.equal(result.exit.noForcedExit, true);
  assert.equal(result.exit.exitEvent, "NO_FORCED_EXIT");
});

test("READY / NEAR_READY / BLOCKED 诊断状态严格分层，NEAR_READY 不进入 Top 3", () => {
  const [pool] = normalizePools([rawPool({ replayEvidence: replayEvidence() })], DASHBOARD_CONFIG);
  const optimizer = searchOptimizer(pool, DASHBOARD_CONFIG);
  const baseEvidence = {
    poolState: { poolStatePass: true },
    tickArrays: { tickArrayPass: true },
    replayEvidence: { ...pool.replayEvidence, candidates: { ...pool.replayEvidence.candidates } },
    swapIndexPass: true,
    swaps: {
      windows: { "24": { windowComplete: true, feeCoverage: 1 } },
      path: { pass: true, coverageRatio: 1, transactionOrderComplete: true },
      parser: { amountReconciliationFailed: 0 },
    },
    shadowReplay: { candidateCount: 87 },
    feeConfigVerified: true,
    feeGrowthReconciliation: { status: "PASS" },
    executionCosts: { quality: "PASS" },
    markout: { quality: "COMPLETE" },
  };
  const readyPool = { ...pool, universeStatus: "ACTIVE_INDEXED", evidence: baseEvidence };
  const ready = buildPoolDiagnostic(readyPool, optimizer);
  assert.equal(ready.status, "READY");
  assert.equal(statusForTop3(ready), true);

  const near = buildPoolDiagnostic({ ...readyPool, evidence: { ...baseEvidence, markout: { quality: "INCOMPLETE" } } }, optimizer);
  assert.equal(near.status, "NEAR_READY");
  assert.equal(statusForTop3(near), false);

  const blocked = buildPoolDiagnostic({ ...readyPool, currentTick: null }, optimizer);
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(statusForTop3(blocked), false);
  assert.deepEqual(buildDiagnosticReport([{ pool: readyPool, optimizer }, { pool: { ...readyPool, currentTick: null }, optimizer }]).statusCounts, { READY: 1, NEAR_READY: 0, BLOCKED: 1 });
});

test("波动 regime 缺证据时不虚构，并且只作为优化器同净收益候选偏好", () => {
  assert.equal(deriveVolatilityRegime({ evidence: {} }).regime, null);
  assert.equal(deriveVolatilityRegime({ evidence: { poolState: { dynamicFeeInfo: { volatilityAccumulator: 10, maxVolatilityAccumulator: 100 } } } }).regime, "LOW_VOL");
  assert.equal(deriveVolatilityRegime({ evidence: { poolState: { dynamicFeeInfo: { volatilityAccumulator: 90, maxVolatilityAccumulator: 100 } } } }).regime, "HIGH_VOL");
});

test("Opportunity Ranking 保留验证不完整的公开 RWA/USDC Pool", () => {
  const pools = normalizePools([
    rawPool({ id: "pool-a", symbol: "AAA", tvl: 20_000, volume: 50_000, fee: 250 }),
    rawPool({ id: "pool-b", symbol: "BBB", tvl: 8_000, volume: 12_000, fee: 120, feeRate: 0.008 }),
  ], DASHBOARD_CONFIG);
  const optimizerResults = pools.map((pool) => ({ pool, optimizer: searchOptimizer(pool, DASHBOARD_CONFIG) }));
  const diagnostics = buildDiagnosticReport(optimizerResults);
  const ranking = buildOpportunityRanking(pools, optimizerResults, diagnostics);
  assert.equal(ranking.top3.length, 2);
  assert.ok(ranking.top3[0].opportunityScore >= ranking.top3[1].opportunityScore);
  assert.ok(["WATCH", "BLOCKED"].includes(ranking.top3[0].opportunityStatus));
  assert.ok(["WATCH", "REVIEW", "BLOCKED"].includes(ranking.top3[0].action));
  assert.equal(ranking.top3[0].netEstimate, null);
});

test("同一 Pair 只去重相同 Fee Tier，不吞掉不同 Fee Tier", () => {
  const pools = normalizePools([
    rawPool({ id: "pool-a", symbol: "CRCLx", assetAddress: "asset-a", tvl: 20_000, volume: 50_000, fee: 250, feeRate: 0.0025 }),
    rawPool({ id: "pool-a-duplicate", symbol: "CRCLx", assetAddress: "asset-a-duplicate", tvl: 18_000, volume: 45_000, fee: 225, feeRate: 0.0025 }),
    rawPool({ id: "pool-b", symbol: "CRCLx", assetAddress: "asset-b", tvl: 8_000, volume: 12_000, fee: 120, feeRate: 0.008 }),
    rawPool({ id: "pool-c", symbol: "BOT", assetAddress: "asset-c", tvl: 7_000, volume: 11_000, fee: 110, feeRate: 0.0025 }),
  ], DASHBOARD_CONFIG);
  const optimizerResults = pools.map((pool) => ({ pool, optimizer: searchOptimizer(pool, DASHBOARD_CONFIG) }));
  const ranking = buildOpportunityRanking(pools, optimizerResults, buildDiagnosticReport(optimizerResults));
  assert.equal(ranking.top3.length, 3);
  assert.equal(new Set(ranking.top3.map((row) => `${row.pair}::${row.feeTier}`)).size, 3);
  assert.equal(ranking.top3.filter((row) => row.pair === "CRCLx/USDC").length, 2);
});

test("外版页面只展示中文八列决策 Top 3，唯一运行时数据源为 top3.json", () => {
  const pools = normalizePools([rawPool({ replayEvidence: replayEvidence() })], DASHBOARD_CONFIG);
  const optimizerSummary = buildOptimizerResults(pools, DASHBOARD_CONFIG);
  const fetchedAt = new Date().toISOString();
  const page = renderPage({ optimizerSummary, fetchedAt, poolCount: pools.length, config: DASHBOARD_CONFIG });
  const data = JSON.stringify({ scope: { capital: 1_000 }, candidates: [] });

  verifyMarketData(pools, optimizerSummary, DASHBOARD_CONFIG);
  verifyPageMarkup(page);
  verifyDataJson(data);
  assert.match(page, /RWA \/ USDC LP 优化器/);
  assert.match(page, /模拟资金 \$1,000/);
  assert.match(page, /排名/);
  assert.match(page, /池/);
  assert.match(page, /预计日收益/);
  assert.match(page, /TVL/);
  assert.match(page, /手续费率/);
  assert.match(page, /Core/);
  assert.match(page, /Buffer/);
  assert.match(page, /建议/);
  assert.match(page, /详情/);
  assert.match(page, /更多详情/);
  assert.match(page, /top3\.json/);
  assert.doesNotMatch(page, /24h 成交量|24h LP Fee|预计手续费/);
  assert.doesNotMatch(page, /#01/);
  assert.equal((page.match(/role="columnheader"/g) ?? []).length, 8);
  assert.equal(formatTimestamp(fetchedAt) !== null, true);
});

test("无 Top 3 页面只保留运行时空状态，不嵌入旧排名", () => {
  const pools = normalizePools([rawPool()], DASHBOARD_CONFIG);
  const optimizerSummary = buildOptimizerResults(pools, DASHBOARD_CONFIG);
  const page = renderPage({ optimizerSummary, fetchedAt: new Date().toISOString(), poolCount: pools.length, config: DASHBOARD_CONFIG });
  verifyPageMarkup(page);
  assert.match(page, /top3\.json/);
  assert.doesNotMatch(page, /Net 24H/);
});

test("外版快照只接受固定资金、无钱包和可验证哈希", () => {
  const base = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    opportunityGeneratedAt: new Date().toISOString(),
    verificationGeneratedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
    dataFreshness: { state: "FRESH", ageMs: 0, slaMs: DASHBOARD_CONFIG.evidence.freshnessSlaMs },
    opportunityFreshness: { state: "FRESH", ageMs: 0, slaMs: DASHBOARD_CONFIG.opportunityFreshnessSlaMs },
    verificationFreshness: { state: "STALE", ageMs: 7 * 60 * 60_000, slaMs: DASHBOARD_CONFIG.verificationFreshnessSlaMs },
    verificationReady: false,
    sourceEvidence: { api: {}, rpc: {}, evidenceSummary: {} },
    scope: { capital: 1_000, autoExecution: false },
    candidates: [],
    opportunityRanking: { version: 1, featureWeights: {}, candidateCount: 0, top3Count: 0 },
    diagnostics: { version: 1, statusCounts: { READY: 0, NEAR_READY: 0, BLOCKED: 0 }, nearest: [], matrix: [] },
    publicPoolCount: 0,
  };
  const snapshot = { ...base, snapshotHash: snapshotHash(base) };
  verifySnapshot(snapshot, DASHBOARD_CONFIG);
  assert.equal(snapshot.snapshotHash.length, 64);
  assert.equal(snapshotFreshness(snapshot.generatedAt, DASHBOARD_CONFIG.evidence.freshnessSlaMs).state, "FRESH");
});

test("浏览器运行时读取证据快照，而不是直接调用 Raydium API", () => {
  const runtime = renderRuntime(DASHBOARD_CONFIG);
  assert.match(runtime, /top3\.json/);
  assert.match(runtime, /opportunityGeneratedAt/);
  assert.match(runtime, /candidates/);
  assert.doesNotMatch(runtime, /snapshot\.top3/);
  assert.doesNotMatch(runtime, /api-v3\.raydium\.io/);
  assert.doesNotMatch(runtime, /CONFIG\.apiUrl/);
});
