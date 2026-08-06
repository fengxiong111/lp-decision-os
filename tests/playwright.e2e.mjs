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
  await page.waitForFunction(() => document.querySelectorAll(".terminal-table tbody .ranking-row").length > 0, null, { timeout: 90_000 });
  await page.waitForSelector('[data-testid="ranking-loading"]', { state: "detached", timeout: 90_000 }).catch(() => undefined);
}

async function firstRowText(page) {
  return (await page.locator(".terminal-table tbody .ranking-row").first().innerText()).trim();
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
  assert.equal(await page.locator('[data-testid="capital-1000"]').getAttribute("class"), "active");
  assert.match(await page.locator(".ranking-basis").innerText(), /可执行手续费收益|可执行净收益/);
  assert.doesNotMatch(await page.locator(".terminal-table thead").innerText(), /预计净利润/, "净收益模型未完成时主表不得显示预计净利润列");
  assert.deepEqual(await page.locator(".terminal-table thead th").allTextContents(), ["排名", "交易对", "推荐 Pool / Fee Tier", "股票价格", "24小时上下限", "TVL", "24小时成交量", "24小时 LP Fee", "预计手续费收入", "结论 / 原因"]);
  assert.doesNotMatch(await page.locator(".terminal-table thead").innerText(), /更新时间/, "主表不应再显示更新时间列");
  assert.equal(await page.locator('[data-testid^="pair-row-"]').count() > 0, true);

  await page.locator('[data-testid="window-24h"]').click();
  await page.locator(".progress-drawer").waitFor();
  assert.match(await page.locator(".progress-drawer").innerText(), /窗口证据|官方API|完整/);
  await page.locator('[aria-label="关闭窗口进度"]').click();

  const tenKResponse = page.waitForResponse((response) => response.url().includes(`/api/rankings?capital=10000&window=24h`) && response.ok(), { timeout: 90_000 });
  await page.locator('[data-testid="capital-10000"]').click();
  await tenKResponse;
  await waitForRows(page);
  const tenKRow = await firstRowText(page);
  assert.equal(await page.locator('[data-testid="capital-10000"]').getAttribute("class"), "active");
  assert.notEqual(tenKRow, oneKRow, "切换资金后主排名行必须重新计算并改变结果或数值");
  assert.ok(requests.some((url) => url.includes("capital=1000&window=24h")));
  assert.ok(requests.some((url) => url.includes("capital=10000&window=24h")));
  await page.screenshot({ path: `${projectRoot}/terminal-e2e-10000u.jpg`, fullPage: false, type: "jpeg", quality: 88 });

  const layout = await page.evaluate(() => {
    const controls = document.querySelector(".terminal-controls")?.getBoundingClientRect();
    const rows = [...document.querySelectorAll(".terminal-table tbody .ranking-row")].map((row) => row.getBoundingClientRect());
    const visible = rows.filter((row) => row.top >= 0 && row.bottom <= window.innerHeight).length;
    return { controlsBottom: controls?.bottom ?? Infinity, visibleRows: visible, fifteenthBottom: rows[14]?.bottom ?? Infinity };
  });
  assert.ok(layout.controlsBottom <= 90, `顶部状态与控件应控制在90px内，实际 ${layout.controlsBottom}px`);
  assert.ok(layout.visibleRows >= 15 || layout.fifteenthBottom <= 1080, `1920×1080应至少容纳15行，实际可见 ${layout.visibleRows} 行`);

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

  const copyButton = page.locator('[data-testid^="main-copy-pool-"]').first();
  await copyButton.click();
  await page.locator('[role="status"]').waitFor({ timeout: 5_000 });
  assert.match(await page.locator('[role="status"]').innerText(), /已复制/);
  assert.equal(consoleErrors.length, 0, `浏览器控制台出现错误：${consoleErrors.join(" | ")}`);

  await page.waitForTimeout(1_600);
  await page.locator('[data-testid="capital-1000"]').click();
  await waitForRows(page);
  await page.waitForTimeout(1_600);
  await page.screenshot({ path: `${projectRoot}/terminal-e2e-1000u.jpg`, fullPage: false, type: "jpeg", quality: 88 });

  const ipad = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  await ipad.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await waitForRows(ipad);
  assert.equal(await ipad.locator(".terminal-table thead th").count(), 10, "iPad 主表应保持十个决策字段");
  assert.ok(await ipad.locator(".table-scroll").evaluate((scroll) => scroll.scrollWidth > scroll.clientWidth), "iPad 主表应保持真实表格横向滚动");
  await ipad.screenshot({ path: `${projectRoot}/terminal-e2e-ipad.jpg`, fullPage: false, type: "jpeg", quality: 88 });
  await ipad.close();
  console.log(JSON.stringify({
    oneKTop: oneKRow.split("\n").slice(0, 3).join(" / "),
    tenKTop: tenKRow.split("\n").slice(0, 3).join(" / "),
    rankingRequests: requests,
    layout,
    screenshots: ["terminal-e2e-1000u.jpg", "terminal-e2e-10000u.jpg", "terminal-e2e-ipad.jpg"],
  }, null, 2));
} finally {
  if (browser) await browser.close();
  if (child.exitCode === null) child.kill("SIGTERM");
}
