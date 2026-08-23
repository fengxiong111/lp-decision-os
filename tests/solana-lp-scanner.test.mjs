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
import { MeteoraAdapter, RaydiumAdapter, normalizeScannerPools } from "../scripts/mobile-dashboard/adapters.mjs";
import { MarketScanner } from "../scripts/mobile-dashboard/market-scanner.mjs";
import { decidePool, DecisionEngine } from "../scripts/mobile-dashboard/decision-engine.mjs";
import { RiskEngine } from "../scripts/mobile-dashboard/risk-engine.mjs";
import { StrategyEngine } from "../scripts/mobile-dashboard/strategy-engine.mjs";
import { finite, PoolSchema } from "../scripts/mobile-dashboard/pool-schema.mjs";

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
  assert.ok(result.candidates[0].strategySimulation.grossFee24h >= result.candidates[1].strategySimulation.grossFee24h);
  assert.equal(result.rankingBasis, "STRATEGY_SIMULATION_GROSS_PREVIEW");
});

test("缺少真实 Replay 时不把官方 Fee 伪装成可执行净收益", () => {
  const [pool] = [normalizeRaydiumPool(rayPool())];
  const [row] = buildScannerCandidates([pool]).candidates;
  assert.equal(row.lpFee24h, 1_000);
  assert.equal(row.riskModel.status, "WAITING_REPLAY");
  assert.equal(row.verifiedNetReturn, null);
  assert.equal(row.strategySimulation.status, "SIMULATED");
  assert.equal(row.strategySimulation.grossFee24h, 1_000 * (1_000 / 101_000));
  assert.equal(row.decision, "CONSIDER");
  assert.equal(Object.hasOwn(row, "lpScore"), false);
  assert.ok(row.why.negative.some((reason) => reason.includes("Replay")));
});

test("策略模拟只输出官方 LP Fee 的投入后毛收益基准，不冒充净收益", () => {
  const [pool] = [normalizeRaydiumPool(rayPool({ tvl: 200_000, day: { ...rayPool().day, volumeFee: 900 } }))];
  const [row] = buildScannerCandidates([pool]).candidates;
  assert.equal(row.strategySimulation.method, "OFFICIAL_POOL_LP_FEE_PRO_RATA_WITH_SELF_DILUTION");
  assert.equal(row.strategySimulation.grossFee24h, 900 * (1_000 / 201_000));
  assert.equal(row.strategySimulation.coreGrossFee24h, 900 * (1_000 / 201_000) * 0.7);
  assert.equal(row.riskModel.expectedNetReturn, null);
  assert.equal(row.verifiedNetReturn, null);
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
  assert.equal(row.riskModel.status, "COMPLETE");
  assert.equal(row.riskModel.expectedNetReturn, 15.3);
  assert.equal(row.verifiedNetReturn, 15.3);
  assert.equal(row.strategy.core.capital, 700);
  assert.equal(row.strategy.buffer.capital, 300);
  assert.equal(row.strategy.search.candidateCount, 36);
  assert.equal(row.decision, "CONSIDER");
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

test("Adapter 层输出统一 PoolSchema，MarketScanner 不携带策略或风险结论", () => {
  assert.equal(finite(null), null);
  assert.equal(finite(undefined), null);
  assert.equal(finite(0), 0);
  const rayAdapter = new RaydiumAdapter();
  const metAdapter = new MeteoraAdapter();
  const ray = rayAdapter.normalize(rayPool());
  const met = metAdapter.normalize(meteoraPool());
  assert.equal(PoolSchema.validate(ray), true);
  assert.equal(PoolSchema.validate(met), true);
  assert.equal(ray.dex, "Raydium");
  assert.equal(ray.poolType, "CLMM");
  assert.equal(met.dex, "Meteora");
  assert.equal(met.poolType, "DLMM");
  assert.deepEqual(normalizeScannerPools({ raydium: [rayPool(), rayPool()], meteora: [meteoraPool()] }).map((row) => row.poolAddress), ["ray-pool", "meteora-pool"]);

  const market = new MarketScanner().discover([ray, met]);
  assert.equal(market.eligible.length, 2);
  assert.equal(Object.hasOwn(market.eligible[0], "strategy"), false);
  assert.equal(Object.hasOwn(market.eligible[0], "risk"), false);
});

test("Strategy、Risk、Decision 可以独立测试，且 Decision 不输出 Score", () => {
  const pool = normalizeRaydiumPool(rayPool());
  const strategyEngine = new StrategyEngine({ capital: 1_000 });
  const strategyRun = strategyEngine.run(pool);
  const riskEngine = new RiskEngine();
  const waitingRisk = riskEngine.evaluate(pool, strategyRun.strategy);
  assert.equal(waitingRisk.status, "WAITING_REPLAY");

  const watch = decidePool({ strategy: strategyRun.strategy, simulation: { status: "WAITING_MARKET_DATA" }, risk: waitingRisk });
  assert.equal(watch.decision, "WATCH");

  const consider = new DecisionEngine().decide({ strategy: strategyRun.strategy, simulation: strategyRun.simulation, risk: waitingRisk });
  assert.equal(consider.decision, "CONSIDER");

  const enter = decidePool({
    strategy: { ...strategyRun.strategy, executionReady: true },
    simulation: strategyRun.simulation,
    risk: { ...waitingRisk, status: "COMPLETE", riskLevel: "LOW", expectedNetReturn: 1 },
  });
  assert.equal(enter.decision, "ENTER");
  assert.equal(Object.hasOwn(enter, "score"), false);
  assert.equal(Object.hasOwn(enter, "lpScore"), false);
});
