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

let currentTop3 = [];
const server = createServer(async (request, response) => {
  if (request.url?.startsWith("/top3.json")) {
    const snapshot = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      snapshotHash: "a".repeat(64),
      dataFreshness: { state: "FRESH", ageMs: 0, slaMs: 3_600_000 },
      scope: { capital: 1_000, autoExecution: false },
      top3: currentTop3,
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
    currentTop3 = fixture;
    await page.goto(`${baseUrl}/?fixture=${fixture.length}`, { waitUntil: "domcontentloaded" });
    if (expectedRows === 0) {
      await page.waitForSelector("#empty-state:not([hidden])");
    } else {
      await page.waitForFunction((count) => document.querySelectorAll("#ranking-list .optimizer-row").length === count, expectedRows);
    }
    assert.equal(await page.locator("#ranking-list .optimizer-row").count(), expectedRows, `top3=${fixture.length} 行数错误`);
    if (expectedRows === 0) {
      assert.equal(await page.locator("#empty-state").innerText(), "等待机会快照\n当前没有可展示的 RWA/USDC 机会候选。", "空机会层文案错误");
      assert.equal(await page.locator(".pair").count(), 0, "空机会层不得出现候选行");
    }
  }
  currentTop3 = [makeRow(1)];
  await page.goto(`${baseUrl}/?why=1`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll("#ranking-list .optimizer-row").length === 1);
  await page.locator(".row-tools .why-trigger").click();
  await page.waitForSelector("#why-drawer:not([hidden])");
  assert.match(await page.locator("#why-drawer").innerText(), /Swap replay/);
  console.log(JSON.stringify({ status: "PASS", cases: [0, 1, 3, 4], renderedRows: [0, 1, 3, 3] }, null, 2));
} finally {
  await browser.close();
  await new Promise((resolveServer) => server.close(resolveServer));
}
