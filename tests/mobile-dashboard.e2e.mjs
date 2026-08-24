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
    decision: "DISCOVER",
    decisionReasonCode: "SIMULATED_GROSS_ONLY",
    decisionReason: "市场机会已发现，等待进入 Replay 验证",
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
    const replayQueue = currentCandidates.slice(0, 3).map((row) => ({
      priority: row.rank,
      poolAddress: row.poolAddress,
      pair: row.pair,
      dex: row.dex,
      poolType: row.poolType,
      feeTier: row.feeTier,
      status: "BACKFILLING",
      reason: "SWAP_BACKFILL_INCOMPLETE",
      generatedAt,
      windows: [1, 6, 12, 24].map((windowHours) => ({
        windowHours,
        completedSwaps: row.rank,
        totalSwaps: null,
        coverageRatio: 0.25,
        status: "BACKFILLING",
        windowComplete: false,
        gapCount: null,
        unresolvedRetryableTransactions: 0,
      })),
    }));
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
        replayQueue,
      },
      scope: { protocols: ["Raydium", "Meteora"], poolTypes: ["CLMM", "DLMM"], capital: 1_000, shadowPosition: true, walletDependency: false, autoExecution: false },
      scanner: {
        version: 1,
        generatedAt,
        allPoolCount: 10,
        eligiblePoolCount: currentCandidates.length,
        excludedPoolCount: 0,
        excludedByReason: {},
        rankingBasis: "OPPORTUNITY_RISK_ADJUSTED",
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
    { candidates: Array.from({ length: 50 }, (_, index) => makeCandidate(index + 1)), visibleRows: 50 },
  ];
  for (const [index, fixture] of cases.entries()) {
    currentCandidates = fixture.candidates;
    await page.goto(`${baseUrl}/?case=${index}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction((expected) => document.querySelectorAll("#pool-list .pool-row").length === expected, fixture.visibleRows);
    assert.equal(await page.locator("#pool-list .pool-row").count(), fixture.visibleRows);
    if (fixture.visibleRows === 0) {
      assert.equal(await page.locator("#empty-state").isHidden(), false);
    } else {
      assert.equal(await page.locator("#empty-state").isHidden(), true);
      const bodyText = await page.locator("body").innerText();
      assert.match(bodyText, /LP Fee Ranking/);
      assert.match(bodyText, /TVL/);
      assert.match(bodyText, /Volume/);
      assert.match(bodyText, /Fee/);
      assert.doesNotMatch(bodyText, /流动性池|探索|策略|Strategy Lab|Replay|ENTER|Risk|操作|详情|Fee \/ TVL|Volume \/ TVL/);
    }
  }

  const marketOnly = makeCandidate(1);
  delete marketOnly.strategy;
  delete marketOnly.strategySimulation;
  delete marketOnly.riskModel;
  delete marketOnly.decision;
  currentCandidates = [marketOnly];
  await page.goto(`${baseUrl}/?market-only=1`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll("#pool-list .pool-row").length === 1);
  assert.match(await page.locator("#pool-list").innerText(), /ASSET1 \/ USDC/);
  assert.match(await page.locator("#pool-list").innerText(), /\$1,999/);

  currentCandidates = Array.from({ length: 50 }, (_, index) => makeCandidate(index + 1));
  await page.goto(`${baseUrl}/?mixed-dex=1`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll("#pool-list .pool-row").length === 50);
  assert.equal(await page.locator("#pool-list .pool-row").count(), 50);
  assert.deepEqual(await page.locator("#pool-list .pool-fee strong").first().textContent(), "$1,999.00");
  assert.deepEqual(await page.locator("#pool-list .pool-fee strong").last().textContent(), "$1,950.00");
  assert.deepEqual(await page.locator("#pool-list .pool-venue strong").allTextContents().then((values) => new Set(values)), new Set(["Raydium", "Meteora"]));
  assert.equal(await page.locator(".detail-button").count(), 0);
  assert.equal(await page.getByRole("columnheader").count(), 6);
  assert.equal(await page.locator("#market-status").textContent(), "官方 API · 24H LP Fee DESC");
  const ipad = await browser.newPage({ viewport: { width: 1024, height: 1366 } });
  await ipad.goto(`${baseUrl}/?ipad=1`, { waitUntil: "domcontentloaded" });
  await ipad.waitForFunction(() => document.querySelectorAll("#pool-list .pool-row").length === 50);
  assert.equal(await ipad.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await ipad.close();
  console.log(JSON.stringify({ status: "PASS", cases: [0, 1, 3, 4, 50], renderedRows: [0, 1, 3, 4, 50], defaultSort: "24H LP Fee DESC", mixedDex: true, ipadNoHorizontalScroll: true }, null, 2));
} finally {
  await browser.close();
  await new Promise((resolveServer) => server.close(resolveServer));
}
