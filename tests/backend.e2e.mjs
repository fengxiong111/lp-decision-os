import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { chromium } from "playwright";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForBackend(url, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Fastify exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {
      // server booting
    }
    await wait(200);
  }
  throw new Error("Fastify backend boot timeout");
}

const port = await freePort();
const child = spawn(process.execPath, ["--import", "tsx", "apps/backend/src/server.ts"], {
  cwd: projectRoot,
  env: { ...process.env, LP_BACKEND_PORT: String(port), LP_HOST: "127.0.0.1" },
  stdio: "ignore",
});
const baseUrl = `http://127.0.0.1:${port}`;
let browser;
try {
  await waitForBackend(baseUrl, child);
  const health = await (await fetch(`${baseUrl}/api/health`)).json();
  assert.equal(health.runtime.backend, "FASTIFY");
  assert.equal(health.runtime.frontend, "VITE_STATIC");
  assert.equal(health.diagnostics.database.ok, true);

  const projection = await (await fetch(`${baseUrl}/api/market/snapshot`)).json();
  assert.equal(projection.source, "market-projection");
  assert.equal(typeof projection.projectionVersion, "number");
  assert.ok(projection.snapshot.pools.length > 0);

  const ranking = await (await fetch(`${baseUrl}/api/rankings?capital=1000&window=24h`)).json();
  assert.equal(ranking.capital, 1000);
  assert.ok(ranking.pairs.length > 0);
  assert.deepEqual(ranking.filters, { volume24hGt: 1000, lpFee24hGt: 30, tvlGt: 5000, operator: "AND", applied: true });
  for (const pair of ranking.pairs) {
    const pool = pair.recommendedPool;
    assert.ok(pool && pool.volume24h > 1000 && pool.lpFee24h > 30 && pool.tvl > 5000, `推荐 Pool 未满足默认筛选：${pair.symbol}`);
  }

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--disable-gpu", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const consoleErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid^="pair-row-"]').first().waitFor({ timeout: 30_000 });
  const headers = await page.locator(".terminal-table thead th").allTextContents();
  assert.deepEqual(headers, ["排名", "交易对", "推荐 Pool / Fee Tier", "股票价格", "24小时上下限", "TVL", "24小时成交量", "24小时 LP Fee", "预计手续费收入", "结论 / 原因"]);
  assert.doesNotMatch(headers.join(" "), /更新时间/);
  assert.ok(await page.locator('[data-testid^="pair-row-"]').count() > 0);
  assert.equal(consoleErrors.length, 0, `frontend console errors: ${consoleErrors.join(" | ")}`);
  await page.screenshot({ path: `${projectRoot}/terminal-backend-e2e.jpg`, fullPage: false, type: "jpeg", quality: 88 });

  const ipad = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  await ipad.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await ipad.locator('[data-testid^="pair-row-"]').first().waitFor({ timeout: 30_000 });
  assert.equal(await ipad.locator(".terminal-table thead th").count(), 10);
  assert.ok(await ipad.locator(".table-scroll").evaluate((node) => node.scrollWidth > node.clientWidth));
  await ipad.close();
  await page.close();
  console.log(JSON.stringify({ port, projectionVersion: projection.projectionVersion, pairCount: ranking.pairs.length, screenshot: "terminal-backend-e2e.jpg" }, null, 2));
} finally {
  await browser?.close();
  child.kill("SIGTERM");
}
