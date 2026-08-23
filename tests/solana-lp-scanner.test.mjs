import assert from "node:assert/strict";
import test from "node:test";
import {
  buildScannerCandidates,
  evaluateScannerFilter,
  fetchMeteoraDlmmUniverse,
  fetchRaydiumClmmUniverse,
  normalizeMeteoraPool,
  normalizeRaydiumPool,
  SCANNER_FILTERS,
} from "../scripts/mobile-dashboard/scanner.mjs";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function rayPool(overrides = {}) {
  return {
    id: "ray-pool",
    programId: "RaydiumCLMMProgram",
    mintA: { address: USDC, symbol: "USDC" },
    mintB: { address: "AAA", symbol: "AAA" },
    price: 10,
    tvl: 100_000,
    feeRate: 0.0025,
    config: { tickSpacing: 10 },
    day: { volume: 200_000, volumeFee: 1_000, apr: 100, priceMin: 9.8, priceMax: 10.2 },
    ...overrides,
  };
}

function meteoraPool(overrides = {}) {
  return {
    address: "meteora-pool",
    name: "AAA-USDC",
    token_x: { address: "AAA", symbol: "AAA" },
    token_y: { address: USDC, symbol: "USDC" },
    tvl: 200_000,
    current_price: 10,
    volume: { "24h": 300_000 },
    fees: { "24h": 900 },
    fee_tvl_ratio: { "24h": 0.0045 },
    pool_config: { base_fee_pct: 0.1, bin_step: 20 },
    is_blacklisted: false,
    ...overrides,
  };
}

test("扫描器严格应用 TVL、成交量、异常 APR 和黑名单过滤", () => {
  const normal = normalizeRaydiumPool(rayPool());
  const lowTvl = normalizeRaydiumPool(rayPool({ id: "low", tvl: 50_000 }));
  const lowVolume = normalizeRaydiumPool(rayPool({ id: "low-volume", day: { ...rayPool().day, volume: 50_000 } }));
  const abnormalApr = normalizeRaydiumPool(rayPool({ id: "apr", day: { ...rayPool().day, apr: 10_001 } }));
  const blacklisted = normalizeMeteoraPool(meteoraPool({ address: "blacklisted", is_blacklisted: true }));

  assert.equal(evaluateScannerFilter(normal, SCANNER_FILTERS).eligible, true);
  assert.deepEqual(evaluateScannerFilter(lowTvl, SCANNER_FILTERS).reasons, ["TVL_BELOW_50K"]);
  assert.deepEqual(evaluateScannerFilter(lowVolume, SCANNER_FILTERS).reasons, ["VOLUME_BELOW_50K"]);
  assert.deepEqual(evaluateScannerFilter(abnormalApr, SCANNER_FILTERS).reasons, ["ABNORMAL_APR"]);
  assert.ok(evaluateScannerFilter(blacklisted, SCANNER_FILTERS).reasons.includes("BLACKLISTED"));
});

test("机会扫描生成 Top10，默认展示限制由页面而不是数据层截断", () => {
  const pools = Array.from({ length: 12 }, (_, index) => normalizeRaydiumPool(rayPool({
    id: `ray-${index}`,
    mintB: { address: `AAA-${index}`, symbol: `AAA${index}` },
    tvl: 100_000 + index,
    day: { ...rayPool().day, volumeFee: 100 + index, volume: 200_000 + index },
  })));
  const result = buildScannerCandidates(pools, { limit: 10 });
  assert.equal(result.allPoolCount, 12);
  assert.equal(result.eligiblePoolCount, 12);
  assert.equal(result.candidates.length, 10);
  assert.deepEqual(result.candidates.map((row) => row.rank), Array.from({ length: 10 }, (_, index) => index + 1));
  assert.equal(result.candidates[0].shadowCapital, 1_000);
  assert.equal(result.rankingBasis, "LP_SCORE_MARKET_PREVIEW_WAITING_REPLAY");
});

test("缺少真实 Replay 时不把官方 Fee 伪装成可执行净收益", () => {
  const [pool] = [normalizeRaydiumPool(rayPool())];
  const [row] = buildScannerCandidates([pool]).candidates;
  assert.equal(row.lpFee24h, 1_000);
  assert.equal(row.netModel.status, "WAITING_REPLAY");
  assert.equal(row.expectedNetReturn, null);
  assert.equal(row.recommendation, "观察");
  assert.ok(row.why.negative.some((reason) => reason.includes("Replay")));
});

test("完整 Replay 才计算 Gross Fee 减成本，并使用固定 $1,000 Core/Buffer", () => {
  const [pool] = [normalizeRaydiumPool(rayPool({ replayEvidence: {
    grossFee24h: 20,
    outOfRangeTimeCost: 2,
    rebalanceCost: 1,
    gasCost: 0.5,
    swapSlippage: 0.4,
    impermanentLoss: 0.8,
    rebalanceFrequency: 2,
    confidence: 0.92,
  } }))];
  const [row] = buildScannerCandidates([pool]).candidates;
  assert.equal(row.netModel.status, "COMPLETE");
  assert.equal(row.expectedNetReturn, 15.3);
  assert.equal(row.strategy.core.capital, 700);
  assert.equal(row.strategy.buffer.capital, 300);
  assert.equal(row.strategy.search.candidateCount, 36);
  assert.equal(row.recommendation, "考虑");
});

test("Raydium 使用 Core + Buffer，Meteora 使用波动 regime 对应的 DLMM 策略", () => {
  const ray = buildScannerCandidates([normalizeRaydiumPool(rayPool())]).candidates[0];
  const met = buildScannerCandidates([normalizeMeteoraPool(meteoraPool())]).candidates[0];
  assert.equal(ray.strategy.family, "Core + Buffer");
  assert.equal(ray.strategy.optimizer, "Raydium CLMM");
  assert.equal(ray.strategy.core.capital + ray.strategy.buffer.capital, 1_000);
  assert.equal(ray.strategy.search.candidateCount, 36);
  assert.equal(met.strategy.optimizer, "Meteora DLMM");
  assert.equal(met.strategy.family, "Curve");
  assert.equal(met.strategy.binDistribution.binStep, 20);
  assert.equal(met.strategy.search.candidateCount, 9);
});

test("官方列表没有逐笔交易分布时不宣称刷量已清洗", () => {
  const row = normalizeMeteoraPool(meteoraPool());
  const result = evaluateScannerFilter(row, SCANNER_FILTERS);
  assert.equal(result.eligible, true);
  assert.equal(result.washVolume, "NOT_VERIFIED");
});

test("Raydium cursor 与 Meteora page 分页都完整读取官方源", async () => {
  const rayCalls = [];
  const rayFetch = async (url) => {
    rayCalls.push(String(url));
    const page = rayCalls.length === 1
      ? { data: { data: [rayPool({ id: "one" })], nextPageId: "cursor-2" } }
      : { data: { data: [rayPool({ id: "two" })] } };
    return { ok: true, json: async () => page };
  };
  const ray = await fetchRaydiumClmmUniverse({ fetchImpl: rayFetch, pageSize: 2, maxPages: 5 });
  assert.equal(ray.complete, true);
  assert.equal(ray.pools.length, 2);
  assert.match(rayCalls[1], /nextPageId=cursor-2/);

  const meteoraCalls = [];
  const meteoraFetch = async (url) => {
    meteoraCalls.push(String(url));
    const page = Number(new URL(url).searchParams.get("page"));
    return { ok: true, json: async () => ({ pages: 2, total: 2, data: [meteoraPool({ address: `met-${page}` })] }) };
  };
  const meteora = await fetchMeteoraDlmmUniverse({ fetchImpl: meteoraFetch, pageSize: 2, maxPages: 5 });
  assert.equal(meteora.complete, true);
  assert.equal(meteora.pools.length, 2);
  assert.deepEqual(meteoraCalls.map((url) => Number(new URL(url).searchParams.get("page"))).sort(), [1, 2]);
});
