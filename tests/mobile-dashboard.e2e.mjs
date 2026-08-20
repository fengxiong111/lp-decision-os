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
  net24h: 18 - rank,
  coreCapital: 700,
  coreLower: 140.12,
  coreUpper: 141.36,
  bufferCapital: 300,
  bufferLower: 136.5,
  bufferUpper: 145,
  action,
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
      assert.equal(await page.locator("#empty-state").innerText(), "RWA TOP 3\n0 / 3 READY\n当前没有满足完整证据门槛的可执行 Pool。", "空 Top 3 文案错误");
      assert.equal(await page.locator(".rank").count(), 0, "空 Top 3 不得出现排名编号");
    }
  }
  console.log(JSON.stringify({ status: "PASS", cases: [0, 1, 3, 4], renderedRows: [0, 1, 3, 3] }, null, 2));
} finally {
  await browser.close();
  await new Promise((resolveServer) => server.close(resolveServer));
}
