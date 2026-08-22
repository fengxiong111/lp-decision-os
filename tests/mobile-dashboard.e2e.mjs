import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const artifactDir = resolve("mobile-dashboard");
const action = "OPEN";
const makeRow = (rank) => ({
  rank,
  pair: `ASSET${rank}/USDC`,
  poolAddress: `Pool${rank}`,
  tvl: 10000 + rank,
  volume24h: 20000 + rank,
  lpFee24h: 50 + rank,
  feeTier: 0.0025,
  opportunityScore: 90 - rank,
  opportunityStatus: rank === 1 ? "READY" : "WATCH",
  netEstimate: null,
  coreCapital: null,
  coreLower: null,
  coreUpper: null,
  bufferCapital: null,
  bufferLower: null,
  bufferUpper: null,
  confidence: 50,
  action: rank === 1 ? "OPEN_READY" : action === "OPEN" ? "WATCH" : action,
  evidence: [],
});

const makeDiagnostic = (rank, status = "READY") => ({
  poolAddress: `Pool${rank}`,
  pair: `ASSET${rank}/USDC`,
  status,
  primaryBlocker: status === "READY" ? null : { label: status === "NEAR_READY" ? "Markout" : "Swap replay", display: status === "NEAR_READY" ? "WAITING" : "FAIL" },
  evidence: [{ key: "swapReplay", label: "Swap replay", status: status === "BLOCKED" ? "FAIL" : "PASS", display: status === "BLOCKED" ? "FAIL" : "PASS", reason: "fixture" }],
  netRange: { NET_LOW: 10, NET_BASE: 12, NET_HIGH: 14, reason: "fixture" },
  volatilityRegime: { regime: "NORMAL_VOL", reason: "fixture" },
});
const makeHeatRow = (rank, pair = `ASSET${rank}/USDC`) => ({
  rank,
  pair,
  poolAddress: `HeatPool${rank}`,
  volume24h: 30_000 - rank,
  lpFee24h: 300 - rank,
  tvl: 12_000 + rank,
  feeTier: 0.0025,
});
const makeFeeRow = (rank, dex, pair) => ({
  rank,
  dex,
  pair,
  poolAddress: `${dex}Pool${rank}`,
  tvl: 100_000 + rank,
  volume24h: 200_000 + rank,
  lpFee24h: 2_000 - rank,
  feeTier: 0.0025,
  poolType: dex === "Meteora" ? "DLMM" : "CLMM",
});

let currentCandidates = [];
const server = createServer(async (request, response) => {
  if (request.url?.startsWith("/top3.json")) {
    const opportunityGeneratedAt = new Date().toISOString();
    const verificationGeneratedAt = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    const snapshot = {
      schemaVersion: 1,
      generatedAt: opportunityGeneratedAt,
      opportunityGeneratedAt,
      verificationGeneratedAt,
      snapshotHash: "a".repeat(64),
      dataFreshness: { state: "FRESH", ageMs: 0, slaMs: 1_800_000 },
      opportunityFreshness: { state: "FRESH", ageMs: 0, slaMs: 1_800_000 },
      verificationFreshness: { state: "STALE", ageMs: 25_200_000, slaMs: 21_600_000 },
      verificationReady: false,
      scope: { capital: 1_000, autoExecution: false },
      candidates: currentCandidates,
      marketHeat: [makeHeatRow(1, "BOT/MRNA"), makeHeatRow(2), makeHeatRow(3)],
      feeLeaderboards: {
        generatedAt: opportunityGeneratedAt,
        overall: [makeFeeRow(1, "Raydium", "BOT/MRNA"), makeFeeRow(2, "Meteora", "ASSET2/USDC")],
        rwa: [makeFeeRow(1, "Meteora", "BOT/USDC"), makeFeeRow(2, "Raydium", "ASSET2/USDC")],
      },
      diagnostics: {
        version: 1,
        nearest: [makeDiagnostic(1, "READY"), makeDiagnostic(2, "NEAR_READY"), makeDiagnostic(3, "BLOCKED")],
        matrix: [makeDiagnostic(1, "READY"), makeDiagnostic(2, "NEAR_READY"), makeDiagnostic(3, "BLOCKED")],
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
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
  ...(executablePath ? { executablePath } : {}),
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  for (const [fixture, expectedRows] of [[[], 0], [[makeRow(1)], 1], [[makeRow(1), makeRow(2), makeRow(3)], 3], [[makeRow(1), makeRow(2), makeRow(3), makeRow(4)], 3]]) {
    currentCandidates = fixture;
    await page.goto(`${baseUrl}/?fixture=${fixture.length}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelectorAll("#fee-view-list .fee-row").length === 2);
    assert.equal(await page.locator("#fee-view-list .fee-row").count(), 2, "Fee 总榜必须显示官方两家 DEX 数据");
    assert.match(await page.locator("#fee-view-list").innerText(), /BOT \/ MRNA/);
    assert.equal(await page.locator("#fee-view-list .copy-pool").count(), 2, "每个 Pool 必须有复制按钮");
    await page.getByRole("tab", { name: "RWA Fee Top 10", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll("#rwa-fee-view-list .fee-row").length === 2);
    assert.equal(await page.locator("#rwa-fee-view-list .fee-row").count(), 2, "RWA Fee 榜必须独立显示");
    await page.getByRole("tab", { name: "推荐机会", exact: true }).click();
    if (expectedRows === 0) {
      await page.waitForSelector("#empty-state:not([hidden])");
    } else {
      await page.waitForFunction((count) => document.querySelectorAll("#ranking-list .optimizer-row").length === count, expectedRows);
      assert.equal(await page.locator("#empty-state").isHidden(), true, "Opportunity candidates 不应因 Verification 过期进入空状态");
    }
    assert.equal(await page.locator("#ranking-list .optimizer-row").count(), expectedRows, `candidates=${fixture.length} 行数错误`);
    if (expectedRows === 0) {
      assert.equal(await page.locator("#empty-state").innerText(), "等待计算\n当前没有可展示的 RWA / USDC 机会。", "空机会层文案错误");
      assert.equal(await page.locator("#ranking-list .pool").count(), 0, "空机会层不得出现候选行");
    } else {
      const bodyText = await page.locator("body").innerText();
      assert.doesNotMatch(bodyText, /\$1,000|模拟资金|毛收益估算|Core \/ Buffer|NET LOW/, "外版不应显示本金元素");
      assert.match(bodyText, /24H Volume|24H LP Fee/);
    }
    assert.equal(await page.locator("#fee-view-list .fee-row").count(), 2, "切换推荐榜不应改变 Fee 总榜");
  }
  currentCandidates = [makeRow(1)];
  await page.goto(`${baseUrl}/?why=1`, { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "推荐机会", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll("#ranking-list .optimizer-row").length === 1);
  await page.locator(".row-tools .details-trigger").click();
  await page.waitForSelector("#why-drawer:not([hidden])");
  assert.match(await page.locator("#why-drawer").innerText(), /Swap replay/);
  console.log(JSON.stringify({ status: "PASS", cases: [0, 1, 3, 4], renderedRows: [0, 1, 3, 3] }, null, 2));
} finally {
  await browser.close();
  await new Promise((resolveServer) => server.close(resolveServer));
}
