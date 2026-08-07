import assert from "node:assert/strict";
import test from "node:test";
import type { RaydiumPoolInfo } from "@/services/raydium/api";
import { RAYDIUM_PROGRAMS, USDC_MINT } from "@/services/raydium/config";
import { evaluateResearchUniverse } from "@/services/indexer/universe";

const OTHER_MINT = "RwaBaseMint1111111111111111111111111111111111";
const OTHER_QUOTE = "OtherQuoteMint11111111111111111111111111111111";

function pool(id: string, tvl: number | null, overrides: Partial<RaydiumPoolInfo> = {}): RaydiumPoolInfo {
  return {
    id,
    programId: RAYDIUM_PROGRAMS.CLMM,
    kind: "CLMM",
    pooltype: ["RWA"],
    mintA: { address: OTHER_MINT, symbol: id, name: id, issuer: "issuer", decimals: 6, programId: null },
    mintB: { address: USDC_MINT, symbol: "USDC", name: "USD Coin", issuer: null, decimals: 6, programId: null },
    price: 1,
    mintAmountA: 0,
    mintAmountB: 0,
    feeRate: 0.0025,
    isActive: true,
    identityConflict: null,
    openTime: null,
    tvl,
    day: { volume: 100, volumeFee: 1, apr: 10, feeApr: 10, priceMin: null, priceMax: null },
    week: { volume: 100, volumeFee: 1, apr: 10, feeApr: 10 },
    config: { id: null, tradeFeeRate: 0.0025, tickSpacing:  tickSpacing(), defaultRangePoint: [] },
    hasDynamicFee: false,
    raw: {},
    ...overrides,
  };
}

function tickSpacing() {
  return 10;
}

function at(minutes: number) {
  return new Date(Date.UTC(2026, 7, 6, 0, minutes, 0));
}

test("only verified RWA/USDC pools enter after the 10-minute TVL hysteresis", () => {
  const candidate = pool("eligible", 5_000);
  const nonUsdc = pool("non-usdc", 20_000, { mintB: { address: OTHER_QUOTE, symbol: "OTHER", name: "Other", issuer: null, decimals: 6, programId: null } });
  const conflict = pool("conflict", 20_000, { identityConflict: "Mint 冲突" });

  const first = evaluateResearchUniverse([candidate, nonUsdc, conflict], at(0), { persist: false });
  assert.equal(first.activePoolCount, 0);
  assert.equal(first.officialOnlyPoolCount, 1);
  assert.equal(first.quarantinedPoolCount, 2);

  const afterTen = evaluateResearchUniverse([candidate, nonUsdc, conflict], at(10), { previous: first, persist: false });
  assert.deepEqual(afterTen.activePoolIds, ["eligible"]);
  assert.equal(afterTen.entries.eligible.status, "ACTIVE_INDEXED");
  assert.equal(afterTen.entries["eligible"].tvl, 5_000);
});

test("4,000–5,000 retains active state, and exit needs 30 minutes below 4,000", () => {
  const candidate = pool("eligible", 5_000);
  const active = evaluateResearchUniverse([candidate], at(0), { previous: { generatedAt: at(0).toISOString(), entryTvlUsd: 5_000, exitTvlUsd: 4_000, entryDelayMs: 0, exitDelayMs: 1_800_000, poolCountBeforeFilter: 1, activePoolCount: 1, officialOnlyPoolCount: 0, quarantinedPoolCount: 0, activePairCount: 1, officialOnlyPairCount: 0, activePoolIds: ["eligible"], entries: { eligible: { poolId: "eligible", status: "ACTIVE_INDEXED", tvl: 5_000, aboveThresholdSince: at(0).toISOString(), belowExitThresholdSince: null, lastEvaluatedAt: at(0).toISOString(), reason: "test" } } }, persist: false });
  const hysteresis = evaluateResearchUniverse([pool("eligible", 4_500)], at(5), { previous: active, persist: false });
  assert.equal(hysteresis.entries.eligible.status, "ACTIVE_INDEXED");
  const belowLine = evaluateResearchUniverse([pool("eligible", 3_999)], at(6), { previous: hysteresis, persist: false });
  assert.equal(belowLine.entries.eligible.status, "ACTIVE_INDEXED");
  const beforeExit = evaluateResearchUniverse([pool("eligible", 3_999)], at(35), { previous: belowLine, persist: false });
  assert.equal(beforeExit.entries.eligible.status, "ACTIVE_INDEXED");
  const afterExit = evaluateResearchUniverse([pool("eligible", 3_999)], at(37), { previous: beforeExit, persist: false });
  assert.equal(afterExit.entries.eligible.status, "OFFICIAL_ONLY");
});

test("inactive pools remain official-only even when TVL is large", () => {
  const inactive = pool("inactive", 50_000, { isActive: false });
  const result = evaluateResearchUniverse([inactive], at(20), { persist: false });
  assert.equal(result.entries.inactive.status, "OFFICIAL_ONLY");
  assert.match(result.entries.inactive.reason, /不可交易/);
});
