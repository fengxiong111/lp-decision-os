import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { chromium } from "playwright";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const nextBinary = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
const chromePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHttp(url, child) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`next start exited with code ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The Next server can take a moment to bind after the process starts.
    }
    await wait(250);
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function waitForRows(page) {
  await page.waitForFunction(() => document.querySelectorAll(".kami-ranking-list .ranking-row").length > 0, null, { timeout: 90_000 });
  await page.waitForSelector('[data-testid="ranking-loading"]', { state: "detached", timeout: 90_000 }).catch(() => undefined);
}

async function firstRowText(page) {
  return (await page.locator(".kami-ranking-list .ranking-row").first().innerText()).trim();
}

const port = await freePort();
const child = spawn(process.execPath, [nextBinary, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: projectRoot,
  env: {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: "1",
    READ_ONLY_SOLANA_ADDRESS: "",
    LP_WALLET_CONFIG_PATH: `/tmp/lp-decision-os-playwright-${process.pid}.json`,
  },
  stdio: "ignore",
});

let browser;
try {
  await waitForHttp(`http://127.0.0.1:${port}/`, child);
  browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ["--disable-gpu", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const requests = [];
  const consoleErrors = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/rankings?")) requests.push(request.url());
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await waitForRows(page);
  const oneKRow = await firstRowText(page);
  assert.equal(await page.locator(".kami-feature-card").count(), 0, "首页应直接展示排名");
  assert.equal(await page.locator("h1").count(), 0);
  assert.equal(await page.locator('[data-testid^="pair-row-"]').count() > 0, true);
  assert.equal(await page.locator('[data-testid="spacex-comparison"]').count(), 0, "主表下方不应再显示SpaceX短窗口对比");
  assert.ok(requests.some((url) => url.includes("capital=1000&window=24h")));
  assert.ok(!requests.some((url) => url.includes("capital=10000")), "前端不应请求 10,000U 排名");
  const bodyText = await page.locator("body").innerText();
  for (const removed of ["公开市场：", "实时索引：", "最近 Swap：", "最近成功更新：", "REST兜底", "我的仓位", "系统详情", "投入金额", "决策窗口", "唯一默认排名", "默认筛选", "显示低TVL/隔离池", "10,000U", "1小时", "6小时", "12小时", "RWA LIQUIDITY NOTE", "今天，流动性把机会放在哪里？", "00 · TOP THREE", "优先查看", "01 · FULL RANKING", "1,000U 手续费排名"]) assert.ok(!bodyText.includes(removed), `页面仍显示已移除内容：${removed}`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "桌面不应产生整页横向滚动");

  const spcxxRow = page.locator('[data-testid="pair-row-SPCXx-USDC"]');
  assert.equal(await spcxxRow.count(), 1, "公开市场必须包含SPCXx/USDC");
  await spcxxRow.click();
  await page.locator(".pool-subtable").waitFor();
  const poolDetails = await page.locator(".pool-subtable").innerText();
  assert.match(poolDetails, /Pool \/ Mint \/ Program/);
  assert.match(poolDetails, /Route Share/);
  assert.match(poolDetails, /容量拆解/);
  assert.match(poolDetails, /0\.25%/);
  assert.match(poolDetails, /0\.80%/);

  await page.locator('[data-testid="decision-SPCXx-USDC"]').click();
  const drawer = page.locator(".evidence-drawer");
  await drawer.waitFor();
  const drawerText = await drawer.innerText();
  assert.match(drawerText, /正向贡献/);
  assert.match(drawerText, /负向扣分/);
  assert.match(drawerText, /模型版本/);
  assert.match(drawerText, /官方 APR 不参与默认推荐/);
  await page.locator('[aria-label="关闭排名依据"]').click();

  const copyButton = page.locator('[data-testid^="copy-pool-"]').first();
  await copyButton.click();
  await page.locator('[role="status"]').waitFor({ timeout: 5_000 });
  assert.match(await page.locator('[role="status"]').innerText(), /已复制/);
  assert.equal(consoleErrors.length, 0, `浏览器控制台出现错误：${consoleErrors.join(" | ")}`);

  await page.waitForTimeout(1_600);
  await page.screenshot({ path: `${projectRoot}/terminal-e2e-desktop.jpg`, fullPage: false, type: "jpeg", quality: 88 });

  const ipad = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  await ipad.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await waitForRows(ipad);
  assert.equal(await ipad.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "iPad 不应产生整页横向滚动");
  await ipad.screenshot({ path: `${projectRoot}/terminal-e2e-ipad.jpg`, fullPage: false, type: "jpeg", quality: 88 });
  await ipad.close();

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mobile.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await waitForRows(mobile);
  assert.equal(await mobile.locator(".kami-feature-card").count(), 0);
  assert.equal(await mobile.getByText("10,000U", { exact: true }).count(), 0);
  assert.equal(await mobile.locator("h1").count(), 0);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "手机不应产生整页横向滚动");
  await mobile.screenshot({ path: `${projectRoot}/terminal-e2e-mobile.jpg`, fullPage: false, type: "jpeg", quality: 88 });
  await mobile.close();
  console.log(JSON.stringify({
    oneKTop: oneKRow.split("\n").slice(0, 3).join(" / "),
    rankingRequests: requests,
    screenshots: ["terminal-e2e-desktop.jpg", "terminal-e2e-ipad.jpg", "terminal-e2e-mobile.jpg"],
  }, null, 2));
} finally {
  if (browser) await browser.close();
  if (child.exitCode === null) child.kill("SIGTERM");
}
