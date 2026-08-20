import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const artifactDir = resolve("mobile-dashboard");
const read = (name) => readFile(resolve(artifactDir, name), "utf8");
const [indexHtml, runtimeJs, top3Json, manifestJson] = await Promise.all([
  read("index.html"),
  read("runtime.js"),
  read("top3.json"),
  read("deployment-manifest.json"),
]);

const legacyLabels = ["24h 成交量", "24h LP Fee", "预计手续费"];
const requiredLabels = ["Opportunity Score", "Net Estimate", "Core", "Buffer", "Confidence", "Action", "WHY", "正在验证"];
const actions = new Set(["OPEN_READY", "WATCH", "REVIEW", "BLOCKED"]);
const opportunityStatuses = new Set(["READY", "WATCH", "BLOCKED"]);
const snapshot = JSON.parse(top3Json);
const manifest = JSON.parse(manifestJson);

for (const label of legacyLabels) {
  assert.equal(indexHtml.includes(label) || runtimeJs.includes(label), false, `旧列仍出现在构建产物：${label}`);
}
for (const label of requiredLabels) assert.equal(indexHtml.includes(label), true, `缺少主表字段：${label}`);
assert.equal((indexHtml.match(/role="columnheader"/g) ?? []).length, 7, "主表不是七列");
assert.match(indexHtml, /data-top3-source="\.\/top3\.json"/);
assert.match(indexHtml, /<script type="module" src="\.\/runtime\.js(?:\?[^\"]+)?"><\/script>/);
assert.equal(indexHtml.includes('class="optimizer-row"'), false, "index.html 不应嵌入旧排名行");
assert.equal(runtimeJs.includes("./top3.json"), true, "runtime.js 未读取 top3.json");
for (const forbiddenRuntimeToken of ["lastGoodTop3", "liveBackup", "api-v3.raydium.io", "navigator.serviceWorker", "serviceWorker", "fallback"]) {
  assert.equal(runtimeJs.includes(forbiddenRuntimeToken), false, `runtime.js 仍含旧回退或缓存逻辑：${forbiddenRuntimeToken}`);
}

assert.equal(manifest.sourceDirectory, "mobile-dashboard");
assert.equal(manifest.top3Json, "mobile-dashboard/top3.json");
assert.equal(manifest.pageDataSource, "./top3.json");
assert.equal(manifest.legacyColumnsPresent, false);
assert.equal(manifest.staleFallbackRemoved, true);
assert.equal(manifest.serviceWorker, false);
assert.equal(snapshot.snapshotHash, manifest.snapshotHash);
assert.ok(Array.isArray(snapshot.top3) && snapshot.top3.length <= 3, "top3.json 超过三行");
snapshot.top3.forEach((row, index) => {
  assert.equal(row.rank, index + 1, "Top 3 rank 不连续");
  assert.ok(opportunityStatuses.has(row.opportunityStatus), `Opportunity 状态不允许：${row.opportunityStatus}`);
  assert.equal(typeof row.pair, "string");
  assert.equal(typeof row.poolAddress, "string");
  assert.ok(actions.has(row.action), `Action 不允许：${row.action}`);
  assert.equal(Number.isFinite(row.opportunityScore), true, "Opportunity Score 缺失");
  assert.equal(Number.isFinite(row.confidence), true, "Confidence 缺失");
  for (const field of ["netEstimate", "coreCapital", "coreLower", "coreUpper", "bufferCapital", "bufferLower", "bufferUpper"]) {
    assert.equal(row[field] === null || Number.isFinite(row[field]), true, `Opportunity 字段非法：${field}`);
  }
});
assert.ok(snapshot.publicPoolCount === 0 || snapshot.top3.length > 0, "存在公开 Pool 时机会层不得为空");
assert.equal(snapshot.opportunityRanking?.version, 1, "缺少 Opportunity Ranking 摘要");
assert.ok(Number.isInteger(snapshot.opportunityRanking?.candidateCount), "Opportunity candidateCount 缺失");
assert.equal(snapshot.diagnostics?.version, 1, "缺少诊断版本");
assert.ok(Array.isArray(snapshot.diagnostics?.matrix), "缺少诊断矩阵");
for (const row of snapshot.diagnostics.matrix) {
  assert.ok(["READY", "NEAR_READY", "BLOCKED"].includes(row.status), `诊断状态不允许：${row.status}`);
  assert.ok(Array.isArray(row.evidence), `诊断缺少 Evidence：${row.pair}`);
}

console.log(JSON.stringify({
  status: "PASS",
  sourceDirectory: manifest.sourceDirectory,
  top3Json: manifest.top3Json,
  top3Count: snapshot.top3.length,
  buildHash: snapshot.snapshotHash,
  legacyColumnsPresent: false,
  staleFallbackRemoved: true,
  serviceWorker: false,
}, null, 2));
