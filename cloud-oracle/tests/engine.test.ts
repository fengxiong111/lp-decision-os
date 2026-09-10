import test from "node:test";
import assert from "node:assert/strict";
import { buildAnalysis } from "../analytics/engine";
test("builds nullable core and buffer candidates from public fallback", () => {
  const result = buildAnalysis("0x39dbed3a2bd333467115de45665cc57f813c4571", [{ source: "dexscreener", status: "READY", fetchedAt: new Date().toISOString(), chainId: "robinhood", tokenAddress: "0x39dbed3a2bd333467115de45665cc57f813c4571", blockedReasons: [], error: null, payload: { pair: { baseToken: { name: "Pons", symbol: "PONS" }, priceUsd: "0.65", marketCap: 123, volume: { h24: 1000 } } } }, { source: "geckoterminal", status: "UNAVAILABLE", fetchedAt: new Date().toISOString(), chainId: null, tokenAddress: "x", payload: null, blockedReasons: ["BLOCKED_SOURCE_UNAVAILABLE"], error: "x" }]);
  assert.equal(result.schemaVersion, "lp-oracle-v3.0"); assert.equal(result.candidates.length, 2); assert.equal(result.token.priceUsd, 0.65); assert.ok(Math.abs((result.candidates[0].lowerPriceUsd ?? 0) - 0.572) < 1e-9); assert.ok(result.decision.blockedReasons.includes("BLOCKED_SOURCE_UNAVAILABLE"));
});
