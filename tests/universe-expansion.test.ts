import assert from "node:assert/strict";
import test from "node:test";
import type { RaydiumPoolInfo } from "@/services/raydium/api";
import type { ResearchUniverse } from "@/packages/models/src";
import { RAYDIUM_PROGRAMS, USDC_MINT } from "@/services/raydium/config";
import { evaluateUniverseExpansion, selectExpansionCandidates, selectShortWindowPools } from "@/services/indexer/expansion";
import { PARSER_RECOVERY_TARGETS } from "@/services/indexer/parser-recovery";

function pool(id: string, volume: number, tvl = 10_000, symbol = id, feeRate = 0.0025): RaydiumPoolInfo {
  return {
    id,
    programId: RAYDIUM_PROGRAMS.CLMM,
    kind: "CLMM",
    pooltype: ["RWA"],
    mintA: { address: `${symbol}BaseMint111111111111111111111111111111111`, symbol, name: symbol, issuer: "issuer", decimals: 6, programId: null },
    mintB: { address: USDC_MINT, symbol: "USDC", name: "USD Coin", issuer: null, decimals: 6, programId: null },
    price: 1,
    mintAmountA: 0,
    mintAmountB: 0,
    feeRate,
    isActive: true,
    identityConflict: null,
    openTime: null,
    tvl,
    day: { volume, volumeFee: volume * 0.0025, apr: 10, feeApr: 10, priceMin: null, priceMax: null },
    week: { volume, volumeFee: volume * 0.0025, apr: 10, feeApr: 10 },
    config: { id: `${id}-config`, tradeFeeRate: feeRate, tickSpacing: 10, defaultRangePoint: [] },
    hasDynamicFee: false,
    raw: {},
  };
}

function universeFor(pools: RaydiumPoolInfo[]): ResearchUniverse {
  return {
    generatedAt: "2026-08-06T00:00:00.000Z",
    entryTvlUsd: 5_000,
    exitTvlUsd: 4_000,
    entryDelayMs: 0,
    exitDelayMs: 1_800_000,
    poolCountBeforeFilter: pools.length,
    activePoolCount: pools.length,
    officialOnlyPoolCount: 0,
    quarantinedPoolCount: 0,
    activePairCount: pools.length,
    officialOnlyPairCount: 0,
    activePoolIds: pools.map((item) => item.id),
    entries: Object.fromEntries(pools.map((item) => [item.id, {
      poolId: item.id,
      status: "ACTIVE_INDEXED",
      tvl: item.tvl,
      aboveThresholdSince: "2026-08-06T00:00:00.000Z",
      belowExitThresholdSince: null,
      lastEvaluatedAt: "2026-08-06T00:00:00.000Z",
      reason: "test",
    }])),
  };
}

function passingGates() {
  return {
    parserSuccessRateByPool: {},
    parserSuccessPassed: true,
    feeReconciliationPassRate: 100,
    feeReconciliationPassed: true,
    windows: {},
    windowsPassed: true,
    rpc429RateLast30m: 0,
    rpc429Passed: true,
    realtimeLatencySeconds: 2,
    realtimeLatencyPassed: true,
    websocketGapCount: 0,
    websocketGapPassed: true,
    projectionVersion: 10,
    previousProjectionVersion: 9,
    projectionVersionIncreasing: true,
    cursorResumeVerified: true,
    rankingAutoUpdateVerified: true,
    capitalSizingVerified: true,
  } as const;
}

test("Stage B 只选择 TVL 合格池，并把前五名与 Tier2 分开", () => {
  const pools = Array.from({ length: 7 }, (_, index) => pool(`pool-${index + 1}`, 7_000 - index * 500));
  const result = selectExpansionCandidates(pools, universeFor(pools));
  assert.deepEqual(result.tier1.map((item) => item.id), ["pool-1", "pool-2", "pool-3", "pool-4", "pool-5"]);
  assert.deepEqual(result.tier2.map((item) => item.id), ["pool-6", "pool-7"]);
});

test("SPCX/SPCXx 基线即使不在成交量前五也不能被降级为 Tier2", () => {
  const pools = [
    pool(PARSER_RECOVERY_TARGETS[0].poolId, 100, 10_000, "SPCX"),
    pool(PARSER_RECOVERY_TARGETS[1].poolId, 90, 10_000, "SPCXx", 0.008),
    ...Array.from({ length: 7 }, (_, index) => pool(`high-${index + 1}`, 10_000 - index * 100)),
  ];
  const result = selectExpansionCandidates(pools, universeFor(pools));
  assert.equal(result.tier2.some((item) => PARSER_RECOVERY_TARGETS.some((target) => target.poolId === item.id)), false);
});

test("阶段A任一硬闸门失败时回退基线，阶段B不创建高频目标", () => {
  const pools = Array.from({ length: 7 }, (_, index) => pool(`pool-${index + 1}`, 7_000 - index * 500));
  const universe = universeFor(pools);
  const blocked = evaluateUniverseExpansion(pools, universe, new Date("2026-08-06T00:01:00.000Z"), { persist: false });
  assert.equal(blocked.stage, "STAGE_A");
  assert.equal(blocked.UNIVERSE_5_READY, false);
  assert.deepEqual(blocked.activeShortWindowPoolIds, []);
  assert.ok(blocked.gates.blockers.length > 0);
  const ready = evaluateUniverseExpansion(pools, universe, new Date("2026-08-06T00:02:00.000Z"), { persist: false, gates: passingGates() });
  assert.equal(ready.stage, "STAGE_B");
  assert.equal(ready.UNIVERSE_5_READY, false, "未完成20笔fixture不能宣布UNIVERSE_5_READY");
  assert.deepEqual(ready.tier1PoolIds, ["pool-1", "pool-2", "pool-3", "pool-4", "pool-5"]);
  assert.deepEqual(selectShortWindowPools(pools, ready), [], "尚未通过fixture的新增Pool不得进入高频短窗口");
  const failedFixture = {
    ...ready,
    admission: {
      ...ready.admission,
      [ready.tier1PoolIds[0]]: {
        ...ready.admission[ready.tier1PoolIds[0]],
        fixtureCount: 20,
        fixtureUnsupportedCount: 1,
        parserSuccessRate: 95,
      },
    },
  };
  const rolledBack = evaluateUniverseExpansion(pools, universe, new Date("2026-08-06T00:03:00.000Z"), { previous: failedFixture, persist: false, gates: passingGates() });
  assert.equal(rolledBack.stage, "STAGE_A");
  assert.match(rolledBack.rollbackReason ?? "", /回退上一稳定Universe/);
  assert.deepEqual(rolledBack.activeShortWindowPoolIds, []);
});
