import assert from "node:assert/strict";
import test from "node:test";
import { advanceSwitchSignal } from "@/services/signals/switch";

test("switch signal watches at 20% and confirms only after sustained 30%", () => {
  const first = advanceSwitchSignal(null, { pairId: "SPCXx", fromPool: "a", toPool: "b", candidateAdvantage: 0.22, feeAcceleration: null, volumeAcceleration: null, routeShift: null, dataFresh: true, now: "2026-08-06T03:00:00.000Z", projectionVersion: 1 });
  assert.equal(first.state, "WATCHING");
  const confirmed = advanceSwitchSignal(first, { pairId: "SPCXx", fromPool: "a", toPool: "b", candidateAdvantage: 0.31, feeAcceleration: 0.1, volumeAcceleration: 0.2, routeShift: 0.05, dataFresh: true, now: "2026-08-06T03:31:00.000Z", projectionVersion: 2 });
  assert.equal(confirmed.state, "CONFIRMED");
});

test("stale data invalidates an active signal", () => {
  const watching = advanceSwitchSignal(null, { pairId: "SPCXx", fromPool: "a", toPool: "b", candidateAdvantage: 0.25, feeAcceleration: null, volumeAcceleration: null, routeShift: null, dataFresh: true, now: "2026-08-06T03:00:00.000Z", projectionVersion: 1 });
  const invalid = advanceSwitchSignal(watching, { pairId: "SPCXx", fromPool: "a", toPool: "b", candidateAdvantage: 0.25, feeAcceleration: null, volumeAcceleration: null, routeShift: null, dataFresh: false, now: "2026-08-06T03:01:00.000Z", projectionVersion: 2 });
  assert.equal(invalid.state, "INVALIDATED");
});

