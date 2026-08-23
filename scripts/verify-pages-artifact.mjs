import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const artifactDir = resolve("mobile-dashboard");
const read = (name) => readFile(resolve(artifactDir, name), "utf8");
const snapshotSource = process.env.MOBILE_DASHBOARD_SNAPSHOT_PATH
  ? pathToFileURL(resolve(process.env.MOBILE_DASHBOARD_SNAPSHOT_PATH))
  : new URL("../mobile-dashboard/top3.json", import.meta.url);
const [indexHtml, runtimeJs, snapshotJson, manifestJson] = await Promise.all([
  read("index.html"),
  read("runtime.js"),
  readFile(snapshotSource, "utf8"),
  read("deployment-manifest.json"),
]);
const snapshot = JSON.parse(snapshotJson);
const manifest = JSON.parse(manifestJson);
const artifactMarkup = `${indexHtml}\n${runtimeJs}`;
const legacyLabels = [
  "Market Radar",
  "Strategy Simulation",
  "Verified Net Return",
  "Fee APR",
  "Replay Queue",
  "Opportunity Score",
  "Confidence",
  "24h 成交量",
  "24h LP Fee",
  "预计手续费",
  "实时价格",
  "复制Pool",
];
const hiddenHomeLabels = ["Score", "Opportunity Score", "Confidence", "BLOCKED", "UNAVAILABLE"];
const requiredLabels = ["流动性池", "探索", "策略", "24H 总交易量", "候选池数量", "Raydium 池数量", "Meteora 池数量", "已验证收益池", "热门", "稳健", "高费池", "Raydium", "Meteora", "DEX / 类型", "TVL", "1天交易量", "1天手续费", "资金周转率", "机会等级", "操作", "详情"];
const riskLevels = new Set(["LOW", "MEDIUM", "HIGH", "UNVERIFIED"]);
const decisions = new Set(["DISCOVER", "WATCH", "VERIFYING", "ENTER", "CONSIDER"]);

assert.equal(snapshot.schemaVersion, 2, "Scanner schemaVersion 错误");
assert.equal(snapshot.product, "Solana LP Decision OS");
assert.equal(snapshot.scope?.capital, 1_000);
assert.equal(snapshot.scope?.shadowPosition, true);
assert.equal(snapshot.scope?.walletDependency, false);
assert.equal(snapshot.scope?.autoExecution, false);
assert.deepEqual(new Set(snapshot.scope?.protocols), new Set(["Raydium", "Meteora"]));
assert.equal(snapshot.scanner?.version, 1);
assert.equal(snapshot.scanner?.defaultDisplayLimit, 5);
assert.ok(Array.isArray(snapshot.scanner?.candidates));
assert.ok(snapshot.scanner.candidates.length <= 50);
if (snapshot.scanner.marketLimit !== undefined) assert.equal(snapshot.scanner.marketLimit, 50);
if (snapshot.scanner.replayLimit !== undefined) assert.equal(snapshot.scanner.replayLimit, 10);
if (snapshot.scanner.verificationLimit !== undefined) assert.equal(snapshot.scanner.verificationLimit, 3);
if (snapshot.scanner.top50Count !== undefined) assert.equal(snapshot.scanner.top50Count, snapshot.scanner.candidates.length);
if (snapshot.scanner.top10Count !== undefined) assert.ok(snapshot.scanner.top10Count <= 10);
if (snapshot.sourceEvidence?.replayQueue !== undefined) {
  assert.ok(Array.isArray(snapshot.sourceEvidence.replayQueue));
  assert.ok(snapshot.sourceEvidence.replayQueue.length <= 10);
}
assert.equal(manifest.product, snapshot.product);
assert.equal(manifest.sourceDirectory, "mobile-dashboard");
assert.equal(manifest.top3Json, "mobile-dashboard/top3.json");
assert.equal(manifest.pageDataSource, "./top3.json");
assert.equal(manifest.candidateCount, snapshot.scanner.candidates.length);
assert.equal(manifest.defaultDisplayLimit, 5);
assert.equal(manifest.allPoolCount, snapshot.scanner.allPoolCount);
assert.equal(manifest.eligiblePoolCount, snapshot.scanner.eligiblePoolCount);
assert.equal(manifest.snapshotHash, snapshot.snapshotHash);
assert.equal(manifest.legacyColumnsPresent, false);
assert.equal(manifest.staleFallbackRemoved, true);
assert.equal(manifest.serviceWorker, false);
assert.match(indexHtml, /data-top3-source="\.\/top3\.json"/);
assert.match(indexHtml, /<script type="module" src="\.\/runtime\.js(?:\?[^\"]+)?"><\/script>/);
assert.equal((indexHtml.match(/role="columnheader"/g) ?? []).length, 9);
for (const label of requiredLabels) assert.equal(artifactMarkup.includes(label), true, `缺少字段：${label}`);
for (const label of legacyLabels) assert.equal(artifactMarkup.includes(label), false, `旧字段存在：${label}`);
for (const label of hiddenHomeLabels) assert.equal(indexHtml.includes(label), false, `首页内部字段存在：${label}`);
assert.equal(indexHtml.includes('class="scanner-row"'), false, "静态页不应内嵌候选行");
assert.equal(runtimeJs.includes("scanner.candidates"), true);
assert.equal(runtimeJs.includes("lastGoodTop3"), false);
assert.equal(runtimeJs.includes("fallback"), false);
assert.equal(runtimeJs.includes("navigator.serviceWorker"), false);
snapshot.scanner.candidates.forEach((row, index) => {
  assert.equal(row.rank, index + 1);
  assert.ok(["Raydium", "Meteora"].includes(row.dex));
  assert.ok(["CLMM", "DLMM"].includes(row.poolType));
  assert.equal(typeof row.pair, "string");
  assert.equal(typeof row.poolAddress, "string");
  for (const field of ["tvl", "volume24h", "lpFee24h", "feeTier", "feeApr24h", "volumeTvl", "feeTvl", "priceVolatilityPct", "activeTimeHours", "currentPrice", "verifiedNetReturn"]) {
    assert.equal(row[field] === null || Number.isFinite(row[field]), true, `${field} 非法`);
  }
  assert.equal(row.poolSchemaVersion, 1);
  assert.ok(row.strategy && row.strategySimulation && row.riskModel);
  assert.ok(["SIMULATED", "WAITING_MARKET_DATA"].includes(row.strategySimulation.status));
  assert.equal(typeof row.strategySimulation.method, "string");
  assert.ok(riskLevels.has(row.riskModel.riskLevel));
  assert.ok(decisions.has(row.decision));
  assert.equal(Object.hasOwn(row, "lpScore"), false);
  assert.equal(Object.hasOwn(row, "scoreBreakdown"), false);
  assert.equal(Object.hasOwn(row, "netModel"), false);
});

console.log(JSON.stringify({
  status: "PASS",
  product: snapshot.product,
  sourceDirectory: manifest.sourceDirectory,
  allPoolCount: snapshot.scanner.allPoolCount,
  eligiblePoolCount: snapshot.scanner.eligiblePoolCount,
  top50Count: snapshot.scanner.candidates.length,
  defaultDisplayLimit: snapshot.scanner.defaultDisplayLimit,
  buildHash: snapshot.snapshotHash,
  walletDependency: false,
  autoExecution: false,
}, null, 2));
