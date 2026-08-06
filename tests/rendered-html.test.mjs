import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import test from "node:test";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const nextBinary = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));

async function getFreePort() {
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

async function fetchWithTimeout(url, timeoutMs = 20_000, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function waitForPage(url, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`next start exited before serving HTML with code ${child.exitCode}`);
    try {
      const response = await fetchWithTimeout(url);
      if (response.status === 200) return response;
    } catch {
      // Next.js may still be booting or the live data snapshot may be warming.
    }
    await wait(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

test("Next.js serves the Chinese real-data RWA decision surface", async () => {
  const port = await getFreePort();
  const child = spawn(process.execPath, [nextBinary, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
      READ_ONLY_SOLANA_ADDRESS: "",
      LP_WALLET_CONFIG_PATH: `/tmp/lp-decision-os-rendered-test-wallet-${process.pid}.json`,
    },
    stdio: "ignore",
  });

  try {
    const response = await waitForPage(`http://127.0.0.1:${port}/`, child);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /<title>LP Alpha Terminal · RWA Liquidity Intelligence<\/title>/i);
    for (const label of ["投入金额", "决策窗口", "唯一默认排名", "添加只读钱包", "1小时", "6小时", "12小时", "24小时", "系统详情"]) {
      assert.ok(html.includes(label), `missing label: ${label}`);
    }
    const forbiddenCopy = ["B" + "ONK", "R" + "AY / USDC", "S" + "OL / USDC", "演示", "示例", "SkeletonPreview", "Next.js error", "RWA / USDC 决策证据", "校准闭锁", "ONE QUESTION", "Top Opportunities", "WATCH", "★", "$5k", "$50k", "$100k"];
    // Next RSC 会在 script payload 中序列化内部 decision enum；验收用户实际可见的 HTML，
    // 而不是把内部协议值误判成页面文案。
    const visibleHtml = html.replace(/<script[\s\S]*?<\/script>/gi, "");
    assert.ok(forbiddenCopy.every((value) => !visibleHtml.toLowerCase().includes(value.toLowerCase())));

    const healthResponse = await fetchWithTimeout(`http://127.0.0.1:${port}/api/health`);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.ok(["LIVE_RWA_DATA_BETA_VALIDATING", "LIVE_RWA_DATA_FULLY_CONNECTED", "LIVE_RWA_DATA_PARTIAL", "NO_TRUSTED_DATA"].includes(health.status));
    assert.equal(health.network, "Solana Mainnet");
    assert.equal(typeof health.discovery.rwaAssetCount, "number");
    assert.equal(typeof health.discovery.candidatePoolCount, "number");
    assert.equal(typeof health.discovery.verifiedPoolCount, "number");
    assert.equal(typeof health.discovery.assetCoverage.identityVerifiedAssetCount, "number");
    assert.equal(typeof health.publicMarket.status, "string");
    assert.equal(typeof health.publicMarket.level, "string");
    assert.equal(typeof health.statusReport.PUBLIC_MARKET_STATUS, "string");
    assert.equal(typeof health.statusReport.RPC_VERIFICATION_STATUS, "string");
    assert.equal(typeof health.statusReport.REALTIME_INDEXING_STATUS, "string");
    assert.equal(typeof health.statusReport.WALLET_POSITION_STATUS, "string");
    assert.equal(typeof health.statusReport.NET_YIELD_STATUS, "string");
    assert.equal(typeof health.statusReport.SHORT_WINDOW_ANALYTICS_STATUS, "string");
    if (health.publicMarket.apiAvailable) assert.ok(health.publicMarket.poolCount > 0);
    assert.equal(typeof health.swapIndexer.status, "string");
    assert.ok(health.swapIndexer.backfillProgress === null || typeof health.swapIndexer.backfillProgress === "number");
    assert.equal(typeof health.swapIndexer.windows["5m"].eventCount, "number");
    assert.equal(typeof health.calibration.status, "string");
    assert.equal(health.ranking.defaultMode, "executableFee");
    for (const key of ["PUBLIC_MARKET_DATA", "REALTIME_STREAM", "HISTORICAL_BACKFILL_1H", "HISTORICAL_BACKFILL_6H", "HISTORICAL_BACKFILL_12H", "HISTORICAL_BACKFILL_24H", "FEE_PARSER", "ROUTE_SHARE", "OFFICIAL_RECONCILIATION", "NET_YIELD_MODEL", "WALLET_POSITIONS"]) {
      assert.equal(typeof health.indexerStatus[key], "string");
    }

    for (const capital of ["1000", "10000"]) {
      for (const window of ["1h", "6h", "12h", "24h"]) {
        const rankingResponse = await fetchWithTimeout(`http://127.0.0.1:${port}/api/rankings?capital=${capital}&window=${window}`);
        assert.equal(rankingResponse.status, 200);
        const ranking = await rankingResponse.json();
        assert.equal(ranking.capital, Number(capital));
        assert.equal(ranking.windowStatus.key, window);
        assert.equal(ranking.window, window);
        assert.ok(["NET_PROFIT", "EXECUTABLE_FEE", "LP_FEE_DENSITY"].includes(ranking.rankingBasis));
        assert.ok(Array.isArray(ranking.pairs));
        assert.equal(new Set(ranking.pairs.map((pair) => pair.pairId)).size, ranking.pairs.length);
        assert.ok(ranking.windowStatus.progress === null || typeof ranking.windowStatus.progress === "number");
        assert.ok(ranking.windowStatus.coverage === null || (ranking.windowStatus.coverage >= 0 && ranking.windowStatus.coverage <= 1));
        for (const pair of ranking.pairs) {
          assert.ok(Array.isArray(pair.allPools));
          assert.equal(typeof pair.decision, "string");
          assert.equal(typeof pair.coverage.state, "string");
          assert.ok(["RECOMMEND", "WATCH", "REJECT", "INSUFFICIENT_DATA"].includes(pair.decision));
          assert.ok(pair.estimatedFeeIncome && typeof pair.estimatedFeeIncome.status === "string");
          assert.ok(pair.estimatedNetProfit && typeof pair.estimatedNetProfit.status === "string");
        }
      }
    }
    const ranking1k = await (await fetchWithTimeout(`http://127.0.0.1:${port}/api/rankings?capital=1000&window=24h`)).json();
    const ranking10k = await (await fetchWithTimeout(`http://127.0.0.1:${port}/api/rankings?capital=10000&window=24h`)).json();
    for (const pair of ranking1k.pairs) {
      assert.ok(Object.hasOwn(pair, "currentPrice"));
      assert.ok(Object.hasOwn(pair, "price24hLow"));
      assert.ok(Object.hasOwn(pair, "price24hHigh"));
    }
    const spcxx = ranking1k.pairs.find((pair) => pair.symbol === "SPCXx/USDC");
    if (spcxx) {
      assert.ok(spcxx.allPools.length >= 2);
      assert.ok(spcxx.allPools.some((pool) => pool.feeTier === "0.25%"));
      assert.ok(spcxx.allPools.some((pool) => pool.feeTier === "0.80%"));
      const wide = spcxx.allPools.find((pool) => pool.feeTier === "0.80%");
      const small = spcxx.allPools.find((pool) => pool.feeTier === "0.25%");
      assert.ok(wide?.estimatedFeeIncome.value !== null);
      assert.ok(["OFFICIAL_24H", "TVL_CONSERVATIVE"].includes(wide?.estimatedFeeIncome.method));
      assert.equal(wide?.estimatedNetProfit.value, null);
      assert.ok(wide?.estimatedNetProfit.missing.some((item) => item.includes("建仓") || item.includes("IL")));
      assert.equal(small?.capacity.status, "禁止");
      const spcxx10k = ranking10k.pairs.find((pair) => pair.symbol === "SPCXx/USDC");
      const wide10k = spcxx10k?.allPools.find((pool) => pool.feeTier === "0.80%");
      assert.ok(wide10k?.estimatedFeeIncome.value !== null);
      assert.notEqual(wide?.estimatedFeeIncome.value, wide10k?.estimatedFeeIncome.value);
      assert.equal(spcxx.recommendedPool?.feeTier, "0.80%");
    }
    const invalidWalletResponse = await fetchWithTimeout(`http://127.0.0.1:${port}/api/wallet`, 10_000);
    assert.equal(invalidWalletResponse.status, 200);
    const invalidWallet = await invalidWalletResponse.json();
    assert.equal(invalidWallet.wallet.configured, false);
    const walletSaveResponse = await fetchWithTimeout(`http://127.0.0.1:${port}/api/wallet`, 30_000, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: "11111111111111111111111111111111" }),
    });
    assert.ok([200, 202].includes(walletSaveResponse.status));
    const walletSaved = await walletSaveResponse.json();
    assert.equal(walletSaved.wallet.configured, true);
    assert.equal(walletSaved.wallet.readOnly, true);
    const walletDeleteResponse = await fetchWithTimeout(`http://127.0.0.1:${port}/api/wallet`, 30_000, { method: "DELETE" });
    assert.equal(walletDeleteResponse.status, 200);
    const walletDeleted = await walletDeleteResponse.json();
    assert.equal(walletDeleted.wallet.configured, false);
  } finally {
    child.kill("SIGTERM");
  }
});
