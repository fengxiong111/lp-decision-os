import { createHash } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { DASHBOARD_CONFIG } from "./mobile-dashboard/config.mjs";
import { renderPage } from "./mobile-dashboard/presentation.mjs";
import { renderRuntime } from "./mobile-dashboard/runtime.mjs";
import { verifyDataJson, verifyPageMarkup, verifySnapshot } from "./mobile-dashboard/verify.mjs";

const outputDir = new URL("../mobile-dashboard/", import.meta.url);
const snapshotUrl = new URL("top3.json", outputDir);
const data = await readFile(snapshotUrl, "utf8");
const snapshot = JSON.parse(data);

verifySnapshot(snapshot, DASHBOARD_CONFIG);
verifyDataJson(data);

const runtime = renderRuntime(DASHBOARD_CONFIG);
const runtimeVersion = createHash("sha256").update(runtime).digest("hex");
const page = renderPage({
  fetchedAt: snapshot.opportunityGeneratedAt ?? snapshot.generatedAt,
  poolCount: snapshot.publicPoolCount ?? null,
  snapshotHash: snapshot.snapshotHash,
  runtimeVersion,
  config: DASHBOARD_CONFIG,
});
verifyPageMarkup(page);

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
  schemaVersion: 1,
  sourceDirectory: "mobile-dashboard",
  top3Json: "mobile-dashboard/top3.json",
  indexHtml: "mobile-dashboard/index.html",
  runtimeJs: "mobile-dashboard/runtime.js",
  pageDataSource: "./top3.json",
  top3Count: snapshot.candidates.length,
  candidateCount: snapshot.candidates.length,
  snapshotHash: snapshot.snapshotHash,
  generatedAt: snapshot.generatedAt,
  opportunityGeneratedAt: snapshot.opportunityGeneratedAt ?? snapshot.generatedAt,
  verificationGeneratedAt: snapshot.verificationGeneratedAt ?? null,
  legacyColumnsPresent: false,
  staleFallbackRemoved: true,
  serviceWorker: false,
}, null, 2));

console.log(JSON.stringify({
  status: "PASS",
  source: "mobile-dashboard/top3.json",
  top3Count: snapshot.candidates.length,
  buildHash: snapshot.snapshotHash,
}, null, 2));
