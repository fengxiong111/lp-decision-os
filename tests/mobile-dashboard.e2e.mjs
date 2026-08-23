import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const artifactDir = resolve("mobile-dashboard");
const now = () => new Date().toISOString();

function makeCandidate(rank, dex = rank % 2 === 0 ? "Meteora" : "Raydium") {
  const isMeteora = dex === "Meteora";
  return {
    rank,
    poolSchemaVersion: 1,
    poolAddress: `${dex}Pool${rank}`,
    pair: `ASSET${rank}/USDC`,
    dex,
    poolType: isMeteora ? "DLMM" : "CLMM",
    programId: isMeteora ? null : "RaydiumCLMMProgram",
    baseMint: `BaseMint${rank}`,
    quoteMint: `QuoteMint${rank}`,
    tvl: 100_000 + rank,
    volume24h: 200_000 + rank,
    lpFee24h: 2_000 - rank,
    feeTier: 0.0025,
    feeMode: isMeteora ? "BASE" : null,
    volumeTvl: 2,
    feeTvl: 0.02,
    priceVolatilityPct: isMeteora ? null : 3,
    activeTimeHours: null,
    activeTimeSource: "fixture",
    apr24h: null,
    feeApr24h: 4.2,
    currentPrice: 100 + rank,
    verifiedNetReturn: null,
    washVolumeStatus: "NOT_VERIFIED",
    strategy: isMeteora ? {
      family: "Curve",
      optimizer: "Meteora DLMM",
      core: null,
      buffer: null,
      allocation: null,
      binDistribution: { mode: "Curve", binStep: 20, candidates: [20, 35, 50] },
      regime: "NORMAL_VOL",
      executionReady: false,
      executionBlocker: "fixture",
    } : {
      family: "Core + Buffer",
      optimizer: "Raydium CLMM",
      core: { widthPct: 0.5, lower: 99.5, upper: 100.5, tickLower: null, tickUpper: null, capital: 700 },
      buffer: { widthPct: 10, lower: 90, upper: 110, tickLower: null, tickUpper: null, capital: 300 },
      allocation: "70/30",
      binDistribution: null,
      regime: "NORMAL_VOL",
      executionReady: false,
      executionBlocker: "fixture",
    },
    strategySimulation: {
      status: "SIMULATED",
      method: "OFFICIAL_POOL_LP_FEE_PRO_RATA_WITH_SELF_DILUTION",
      capital: 1_000,
      grossFee24h: 19.8,
      coreGrossFee24h: isMeteora ? null : 13.86,
      bufferGrossFee24h: isMeteora ? null : 5.94,
      capitalShareAfterDeposit: 1_000 / (100_000 + 1_000),
      note: "fixture simulation; not verified net return",
    },
    riskModel: {
      status: "WAITING_REPLAY",
      riskLevel: "UNVERIFIED",
      reason: "REPLAY_REQUIRED",
      grossFee24h: null,
      outOfRangeTimeCost: null,
      rebalanceCost: null,
      gasCost: null,
      swapSlippage: null,
      impermanentLoss: null,
      expectedNetReturn: null,
      rebalanceFrequency: null,
      confidence: null,
    },
    riskLevel: "UNVERIFIED",
    decision: "CONSIDER",
    decisionReasonCode: "SIMULATED_GROSS_ONLY",
    decisionReason: "市场数据与策略模拟可用，净收益等待完整 Replay",
    filter: { eligible: true, reasons: [], washVolume: "NOT_VERIFIED" },
    why: { positive: ["官方 24H 市场数据"], negative: ["等待真实 Replay / IL / 再平衡成本"] },
    verification: { replay: "WAITING", confidence: null, tickPath: "WAITING", markout: "WAITING", il: "WAITING" },
    source: isMeteora ? "Meteora DLMM API" : "Raydium API v3",
    shadowCapital: 1_000,
  };
}

let currentCandidates = [];
const server = createServer(async (request, response) => {
  if (request.url?.startsWith("/top3.json")) {
    const generatedAt = now();
    const snapshot = {
      schemaVersion: 2,
      product: "Solana LP Decision OS",
      generatedAt,
      snapshotHash: "a".repeat(64),
      sourceEvidence: {
        primary: "fixture",
        fetchedAt: generatedAt,
        complete: true,
        sources: {
          raydium: { dex: "Raydium", poolType: "CLMM", complete: true },
          meteora: { dex: "Meteora", poolType: "DLMM", complete: true },
        },
      },
      scope: { protocols: ["Raydium", "Meteora"], poolTypes: ["CLMM", "DLMM"], capital: 1_000, shadowPosition: true, walletDependency: false, autoExecution: false },
      scanner: {
        version: 1,
        generatedAt,
        allPoolCount: 10,
        eligiblePoolCount: currentCandidates.length,
        excludedPoolCount: 0,
        excludedByReason: {},
        rankingBasis: "STRATEGY_SIMULATION_GROSS_PREVIEW",
        top10Count: currentCandidates.length,
        defaultDisplayLimit: 5,
        filters: { tvlMin: 50_000, volume24hMin: 50_000, maxApr24h: 10_000, maxFeeTvlRatio24h: 0.5 },
        candidates: currentCandidates,
      },
    };
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(snapshot));
    return;
  }
  const file = request.url?.startsWith("/runtime.js") ? "runtime.js" : "index.html";
  try {
    const body = await readFile(resolve(artifactDir, file));
    response.writeHead(200, { "content-type": file.endsWith(".js") ? "text/javascript" : "text/html" });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("not found");
  }
});

await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
const baseUrl = `http://127.0.0.1:${port}`;
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH
  ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], ...(executablePath ? { executablePath } : {}) });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const cases = [
    { candidates: [], visibleRows: 0 },
    { candidates: [makeCandidate(1)], visibleRows: 1 },
    { candidates: [1, 2, 3].map((rank) => makeCandidate(rank)), visibleRows: 3 },
    { candidates: [1, 2, 3, 4].map((rank) => makeCandidate(rank)), visibleRows: 4 },
    { candidates: Array.from({ length: 10 }, (_, index) => makeCandidate(index + 1)), visibleRows: 5 },
  ];
  for (const [index, fixture] of cases.entries()) {
    currentCandidates = fixture.candidates;
    await page.goto(`${baseUrl}/?case=${index}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction((expected) => document.querySelectorAll("#scanner-list .explorer-row").length === expected, fixture.visibleRows);
    assert.equal(await page.locator("#scanner-list .explorer-row").count(), fixture.visibleRows);
    assert.equal(await page.locator("#scanner-list .explorer-row").count() <= 5, true);
    if (fixture.visibleRows === 0) {
      assert.equal(await page.locator("#empty-state").isHidden(), false);
    } else {
      assert.equal(await page.locator("#empty-state").isHidden(), true);
      assert.match(await page.locator("body").innerText(), /LP Explorer/);
      assert.match(await page.locator("body").innerText(), /Strategy Simulation/);
      assert.doesNotMatch(await page.locator("body").innerText(), /Opportunity Score|Confidence|BLOCKED|UNAVAILABLE/);
    }
  }

  currentCandidates = Array.from({ length: 10 }, (_, index) => makeCandidate(index + 1));
  await page.goto(`${baseUrl}/?drawer=1`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll("#scanner-list .explorer-row").length === 5);
  assert.equal(await page.locator("#show-all").isHidden(), false);
  await page.locator("#show-all").click();
  await page.waitForFunction(() => document.querySelectorAll("#scanner-list .explorer-row").length === 10);
  await page.locator(".detail-button").first().click();
  await page.waitForSelector("#detail-drawer:not([hidden])");
  assert.match(await page.locator("#detail-drawer").innerText(), /市场数据/);
  assert.match(await page.locator("#detail-drawer").innerText(), /1000U 模拟策略/);
  assert.match(await page.locator("#detail-drawer").innerText(), /Verified Net Return/);
  assert.match(await page.locator("#detail-drawer").innerText(), /Replay/);
  console.log(JSON.stringify({ status: "PASS", cases: [0, 1, 3, 4, 10], defaultRows: [0, 1, 3, 4, 5], showAllRows: 10 }, null, 2));
} finally {
  await browser.close();
  await new Promise((resolveServer) => server.close(resolveServer));
}
