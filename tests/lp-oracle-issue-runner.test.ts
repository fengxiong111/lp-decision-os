import test from "node:test";
import assert from "node:assert/strict";
import { parseAddressFromIssueTitle, renderComment, toQueueOutput } from "../scripts/lp-oracle-issue-runner";
import type { AnalysisResult } from "../cloud-oracle/schema/types";

const address = "0x39dbed3a2bd333467115de45665cc57f813c4571";
const result: AnalysisResult = {
  schemaVersion: "lp-oracle-v3.0", analyzedAt: "2026-09-10T00:00:00.000Z", request: { address, chain: "base" },
  token: { name: "Pons", symbol: "PONS", priceUsd: 0.65, marketCapUsd: null },
  authority: { primary: "dexscreener", confidence: 0.55, notes: [] },
  sources: [{ source: "dexscreener", status: "READY", fetchedAt: "2026-09-10T00:00:00.000Z", chainId: "base", tokenAddress: address, payload: { pair: { pairAddress: "0xpool", dexId: "uniswap", priceUsd: "0.65", volume: { h24: 1000 } } }, blockedReasons: [], error: null }],
  candidates: [{ kind: "CORE", lowerPriceUsd: 0.572, upperPriceUsd: 0.728, widthPct: 12, score: 72, replay: { sampleHours: 24, observedVolumeUsd: 1000, feeProxyUsd: 3 }, blockedReasons: [] }, { kind: "BUFFER", lowerPriceUsd: 0.455, upperPriceUsd: 0.845, widthPct: 30, score: 67, replay: { sampleHours: 24, observedVolumeUsd: 1000, feeProxyUsd: 3 }, blockedReasons: [] }],
  decision: { action: "WAIT", selected: "CORE", score: 72, blockedReasons: [] },
};

test("strictly parses LP Oracle issue titles", () => {
  assert.equal(parseAddressFromIssueTitle(`[LP_ORACLE] ${address}`), address);
  assert.equal(parseAddressFromIssueTitle(`[LP_ORACLE] ${address.slice(0, -1)}`), null);
  assert.equal(parseAddressFromIssueTitle(`LP_ORACLE ${address}`), null);
});

test("queue output preserves unknown weekly data as null", () => {
  const output = toQueueOutput(result);
  assert.equal(output["7d"], null);
  assert.equal(output.selected_pool?.pair, "0xpool");
  assert.match(renderComment(output), /\[LP_ORACLE_RESULT\]/);
});
