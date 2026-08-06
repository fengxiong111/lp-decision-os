import assert from "node:assert/strict";
import test from "node:test";
import { WINDOW_KEYS, type PoolSnapshot } from "@/packages/models/src";
import { refreshExecutableModels } from "@/services/metrics";
import { sanitizeNullSemantics } from "@/services/shared/null-semantics";
import { buildPersistedPoolMetrics } from "@/services/indexer/buckets";

test("Null Semantics preserves measured zero and removes placeholders", () => {
  const value = sanitizeNullSemantics({ zero: 0, missing: undefined, nan: Number.NaN, infinity: Number.POSITIVE_INFINITY, dash: "—", empty: "", nested: [0, "-", null] });
  assert.deepEqual(value, { zero: 0, missing: null, nan: null, infinity: null, dash: null, empty: null, nested: [0, null, null] });
});

test("a complete zero-trade window remains a real zero", () => {
  const asOf = "2026-08-06T12:00:00.000Z";
  const buckets = Array.from({ length: 60 }, (_, index) => ({
    poolId: "pool-zero",
    bucketStart: new Date(Date.parse(asOf) - (60 - index) * 60_000).toISOString(),
    volumeUsd: 0,
    grossFeeUsd: 0,
    lpFeeUsd: 0,
    swapCount: 0,
    buyVolumeUsd: 0,
    sellVolumeUsd: 0,
    uniqueWalletCount: 0,
    tvlStart: 10_000,
    tvlEnd: 10_000,
    activeTvl: 10_000,
    feeDensity: 0,
    liquidityVelocity: 0,
    coverageRatio: 100,
    status: "COMPLETE" as const,
    source: "test",
    asOf,
  }));
  const result = buildPersistedPoolMetrics({
    pools: [{ id: "pool-zero", pairKey: "asset-zero", tvl: 10_000, effectiveActiveTvl: 10_000 }],
    buckets,
    eventsByPool: new Map(),
    sourceCoverage: {},
    asOf,
  });
  const metric = result.pools["pool-zero"]?.windows["1h"];
  assert.equal(metric?.volume, 0);
  assert.equal(metric?.fee, 0);
  assert.equal(metric?.swapCount, 0);
  assert.equal(metric?.available, true);
});

function executableFixture(overrides: Partial<PoolSnapshot> = {}): PoolSnapshot {
  const windows = Object.fromEntries(WINDOW_KEYS.map((window) => [window, {
    window,
    volume: window === "24h" ? 10_000 : null,
    fee: window === "24h" ? 100 : null,
    grossFeeUsd: window === "24h" ? 100 : null,
    lpFeeUsd: window === "24h" ? 100 : null,
    swapCount: window === "24h" ? 12 : null,
    buyVolumeUsd: null,
    sellVolumeUsd: null,
    uniqueWalletCount: null,
    tvlStart: 1_000,
    tvlEnd: 1_000,
    activeTvl: 1_000,
    feeDensity: null,
    liquidityVelocity: null,
    routeShare: null,
    coverageRatio: window === "24h" ? 100 : null,
    status: window === "24h" ? "COMPLETE" : "UNAVAILABLE",
    firstEventAt: null,
    lastEventAt: null,
    asOf: "2026-08-06T12:00:00.000Z",
    apr: null,
    source: window === "24h" ? "raydium-api-v3" : "unavailable",
    sourceLabel: window === "24h" ? "Raydium API" : "未回补",
    observedAt: "2026-08-06T12:00:00.000Z",
    available: window === "24h",
  }])) as PoolSnapshot["windows"];
  return {
    kind: "CLMM",
    tvl: 1_000,
    effectiveActiveTvl: 1_000,
    fee24h: 100,
    activeLiquidityRatio: null,
    confidence: null,
    windows,
    ...overrides,
  } as PoolSnapshot;
}

test("official 24h facts produce a concrete 1000U estimate without Tick quality", () => {
  const snapshot = refreshExecutableModels(executableFixture());
  const estimate = snapshot.executableEstimates["1000"]["24h"];
  assert.equal(estimate.expectedLpFeeUsd, 50);
  assert.equal(estimate.status, "CAPACITY_BLOCKED");
  assert.equal(estimate.inRangeProbability, 1);
});

test("capital changes the 24h estimate instead of changing the official inputs", () => {
  const snapshot = refreshExecutableModels(executableFixture());
  const oneK = snapshot.executableEstimates["1000"]["24h"].expectedLpFeeUsd;
  const tenK = snapshot.executableEstimates["10000"]["24h"].expectedLpFeeUsd;
  assert.equal(oneK, 50);
  assert.ok(tenK !== null && tenK > oneK);
  assert.equal(tenK, 100 * (10_000 / 11_000));
});

test("capacity thresholds use the actual capital-to-TVL ratio", () => {
  const normal = refreshExecutableModels(executableFixture({ tvl: 100_000, effectiveActiveTvl: 100_000 })).executableEstimates["1000"]["24h"];
  const small = refreshExecutableModels(executableFixture({ tvl: 2_000, effectiveActiveTvl: 2_000 })).executableEstimates["1000"]["24h"];
  const caution = refreshExecutableModels(executableFixture({ tvl: 10_000, effectiveActiveTvl: 10_000 })).executableEstimates["1000"]["24h"];
  assert.equal(normal.capacityStatus, "充足");
  assert.equal(small.capacityStatus, "禁止");
  assert.equal(caution.capacityStatus, "偏小");
});

test("short-window null does not erase official 24h fields", () => {
  const snapshot = refreshExecutableModels(executableFixture());
  assert.equal(snapshot.windows["1h"].volume, null);
  assert.equal(snapshot.windows["24h"].volume, 10_000);
  assert.equal(snapshot.windows["24h"].fee, 100);
  assert.equal(snapshot.executableEstimates["1000"]["24h"].expectedLpFeeUsd, 50);
});

test("zero official fee stays a numeric zero, not a missing estimate", () => {
  const snapshot = refreshExecutableModels(executableFixture({ fee24h: 0, windows: {
    ...executableFixture().windows,
    "24h": { ...executableFixture().windows["24h"], fee: 0, grossFeeUsd: 0, lpFeeUsd: 0 },
  } }));
  assert.equal(snapshot.executableEstimates["1000"]["24h"].expectedLpFeeUsd, 0);
});
