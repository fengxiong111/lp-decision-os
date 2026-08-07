import assert from "node:assert/strict";
import test from "node:test";
import { progressForWindows, validateWindowProgress, windowIsComplete } from "@/services/indexer/progress";

const now = new Date("2026-08-05T12:00:00.000Z");

test("single raw cursor produces monotonic 1h/6h/12h progress", () => {
  const cursors = [{
    poolAddress: "pool",
    oldestFetchedSignature: "sig",
    oldestFetchedBlockTime: "2026-08-05T11:00:00.000Z",
    oldestFetchedSlot: 1,
    targetBlockTime: "2026-08-05T00:00:00.000Z",
    signaturesDiscovered: 10,
    transactionsFetched: 10,
    transactionsParsed: 2,
    transactionsFailed: 0,
    unknownInstructions: 0,
    lastProgressAt: now.toISOString(),
    retryCount: 0,
    status: "RUNNING" as const,
  }];
  const progress = progressForWindows(cursors, 1, now, null);
  assert.notEqual(progress["1h"], null);
  assert.notEqual(progress["6h"], null);
  assert.notEqual(progress["12h"], null);
  assert.ok(progress["1h"]! >= progress["6h"]!);
  assert.ok(progress["6h"]! >= progress["12h"]!);
});

test("invalid historical progress is blocked", () => {
  const result = validateWindowProgress({ "1h": 20, "6h": 40, "12h": 10 });
  assert.equal(result.valid, false);
  assert.match(result.reason ?? "", /BACKFILL_PROGRESS_INVALID/);
});

test("a cursor with failed transactions cannot be complete", () => {
  const evidence = {
    windowStart: "2026-08-05T11:00:00.000Z",
    oldestCoveredBlockTime: "2026-08-05T10:59:59.000Z",
    metricsBucketCount: 60,
  };
  assert.equal(windowIsComplete("COMPLETE", 100, 0, 1, evidence), false);
  assert.equal(windowIsComplete("LIVE", 99.99, 0, 0, evidence), true);
});
