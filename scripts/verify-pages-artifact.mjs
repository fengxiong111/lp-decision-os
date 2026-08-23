import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const artifactDir = resolve("mobile-dashboard");
const read = (name) => readFile(resolve(artifactDir, name), "utf8");
const [indexHtml, runtimeJs, snapshotJson, manifestJson] = await Promise.all([
  read("index.html"),
  read("runtime.js"),
  read("top3.json"),
  read("deployment-manifest.json"),
]);
const snapshot = JSON.parse(snapshotJson);
const manifest = JSON.parse(manifestJson);
const legacyLabels = ["24H Fee 总榜", "RWA Fee Top 10", "预计手续费", "24h LP Fee"];
const hiddenHomeLabels = ["Opportunity Score", "Confidence", "BLOCKED", "UNAVAILABLE"];
const requiredLabels = ["Solana LP Opportunity Scanner", "Top 5 LP Opportunities", "Raydium CLMM", "Meteora DLMM", "Market Radar", "Strategy Simulation", "Verified Net Return", "交易对", "DEX / 类型", "24H交易量 · Vol/TVL", "24H手续费 · Fee/TVL", "TVL", "费率", "策略模拟 · 毛收益", "验证净收益 24H", "风险", "建议", "WHY"];
const riskLevels = new Set(["LOW", "MEDIUM", "HIGH"]);
const recommendations = new Set(["考虑", "观察"]);

assert.equal(snapshot.schemaVersion, 2, "Scanner schemaVersion 错误");
assert.equal(snapshot.product, "Solana LP Opportunity Scanner");
assert.equal(snapshot.scope?.capital, 1_000);
assert.equal(snapshot.scope?.shadowPosition, true);
assert.equal(snapshot.scope?.walletDependency, false);
assert.equal(snapshot.scope?.autoExecution, false);
assert.deepEqual(new Set(snapshot.scope?.protocols), new Set(["Raydium", "Meteora"]));
assert.equal(snapshot.scanner?.version, 1);
assert.equal(snapshot.scanner?.defaultDisplayLimit, 5);
assert.ok(Array.isArray(snapshot.scanner?.candidates));
assert.ok(snapshot.scanner.candidates.length <= 10);
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
assert.equal((indexHtml.match(/role="columnheader"/g) ?? []).length, 12);
for (const label of requiredLabels) assert.equal(indexHtml.includes(label), true, `缺少字段：${label}`);
for (const label of legacyLabels) assert.equal(indexHtml.includes(label) || runtimeJs.includes(label), false, `旧字段存在：${label}`);
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
  for (const field of ["tvl", "volume24h", "lpFee24h", "feeTier", "volumeTvl", "feeTvl", "priceVolatilityPct", "activeTimeHours", "expectedNetReturn", "lpScore"]) {
    assert.equal(row[field] === null || Number.isFinite(row[field]), true, `${field} 非法`);
  }
  assert.ok(row.strategy && row.strategySimulation && row.netModel);
  assert.ok(["SIMULATED", "WAITING_MARKET_DATA"].includes(row.strategySimulation.status));
  assert.equal(typeof row.strategySimulation.method, "string");
  assert.ok(riskLevels.has(row.riskLevel));
  assert.ok(recommendations.has(row.recommendation));
});

console.log(JSON.stringify({
  status: "PASS",
  product: snapshot.product,
  sourceDirectory: manifest.sourceDirectory,
  allPoolCount: snapshot.scanner.allPoolCount,
  eligiblePoolCount: snapshot.scanner.eligiblePoolCount,
  top10Count: snapshot.scanner.candidates.length,
  defaultDisplayLimit: snapshot.scanner.defaultDisplayLimit,
  buildHash: snapshot.snapshotHash,
  walletDependency: false,
  autoExecution: false,
}, null, 2));
