import { createHash } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DASHBOARD_CONFIG } from "./mobile-dashboard/config.mjs";
import { renderPage } from "./mobile-dashboard/presentation.mjs";
import { renderRuntime } from "./mobile-dashboard/runtime.mjs";
import { verifyDataJson } from "./mobile-dashboard/verify.mjs";

const outputDir = new URL("../mobile-dashboard/", import.meta.url);
const snapshotUrl = process.env.MOBILE_DASHBOARD_SNAPSHOT_PATH
  ? pathToFileURL(resolve(process.env.MOBILE_DASHBOARD_SNAPSHOT_PATH))
  : new URL("top3.json", outputDir);
const data = await readFile(snapshotUrl, "utf8");
const snapshot = JSON.parse(data);

function verifyCommittedSnapshot(value) {
  if (value?.schemaVersion !== 2) throw new Error("Scanner 快照 schemaVersion 不正确");
  if (value.product !== "Solana LP Decision OS") throw new Error("缺少 LP Decision OS 产品标识");
  if (value.scope?.capital !== DASHBOARD_CONFIG.capital || value.scope?.shadowPosition !== true) throw new Error("Shadow Position 配置不正确");
  if (value.scope?.walletDependency !== false || value.scope?.autoExecution !== false) throw new Error("钱包或自动执行边界不正确");
  if (!Array.isArray(value.scope?.protocols) || !value.scope.protocols.includes("Raydium") || !value.scope.protocols.includes("Meteora")) throw new Error("Scanner 协议范围不正确");
  if (!value.scanner || value.scanner.version !== 1 || value.scanner.defaultDisplayLimit !== 5) throw new Error("Scanner 展示配置不正确");
  if (!Array.isArray(value.scanner.candidates) || value.scanner.candidates.length > 50) throw new Error("Scanner 候选超过 Top50");
  if (value.scanner.marketLimit !== undefined && value.scanner.marketLimit !== 50) throw new Error("Scanner marketLimit 不正确");
  if (value.scanner.replayLimit !== undefined && value.scanner.replayLimit !== 10) throw new Error("Scanner replayLimit 不正确");
  if (value.scanner.verificationLimit !== undefined && value.scanner.verificationLimit !== 3) throw new Error("Scanner verificationLimit 不正确");
  if (value.scanner.top50Count !== undefined && value.scanner.top50Count !== value.scanner.candidates.length) throw new Error("Scanner top50Count 不正确");
  if (value.scanner.top10Count !== undefined && value.scanner.top10Count > 10) throw new Error("Scanner top10Count 超过 Top10");
  if (!value.sourceEvidence?.sources?.raydium || !value.sourceEvidence?.sources?.meteora) throw new Error("缺少 Raydium/Meteora 官方源证据");
}

verifyCommittedSnapshot(snapshot);
verifyDataJson(data);
const runtime = renderRuntime(DASHBOARD_CONFIG);
const runtimeVersion = createHash("sha256").update(runtime).digest("hex");
const page = renderPage({
  fetchedAt: snapshot.generatedAt,
  snapshotHash: snapshot.snapshotHash,
  runtimeVersion,
});

await writeFile(new URL("index.html", outputDir), page);
await writeFile(new URL("runtime.js", outputDir), runtime);
for (const legacyFile of ["data.json", "top3-next.json"]) {
  try {
    await unlink(new URL(legacyFile, outputDir));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
await writeFile(new URL("deployment-manifest.json", outputDir), JSON.stringify({
  schemaVersion: 2,
  product: snapshot.product,
  sourceDirectory: "mobile-dashboard",
  top3Json: "mobile-dashboard/top3.json",
  indexHtml: "mobile-dashboard/index.html",
  runtimeJs: "mobile-dashboard/runtime.js",
  pageDataSource: "./top3.json",
  candidateCount: snapshot.scanner.candidates.length,
  defaultDisplayLimit: snapshot.scanner.defaultDisplayLimit,
  allPoolCount: snapshot.scanner.allPoolCount,
  eligiblePoolCount: snapshot.scanner.eligiblePoolCount,
  snapshotHash: snapshot.snapshotHash,
  generatedAt: snapshot.generatedAt,
  legacyColumnsPresent: false,
  staleFallbackRemoved: true,
  serviceWorker: false,
}, null, 2));

console.log(JSON.stringify({
  status: "PASS",
  product: snapshot.product,
  source: "mobile-dashboard/top3.json",
  candidateCount: snapshot.scanner.candidates.length,
  defaultDisplayLimit: snapshot.scanner.defaultDisplayLimit,
  buildHash: snapshot.snapshotHash,
}, null, 2));
