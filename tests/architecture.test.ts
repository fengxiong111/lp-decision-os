import assert from "node:assert/strict";
import test from "node:test";
import { calculateCapacity, estimateLpFee } from "@/packages/domain/src";
import { normalizeNullSemantics, MetricValueSchema } from "@lp-alpha/shared-types";
import { acceptsProjectionUpdate, readMarketProjection } from "@/services/projection/market";
import { checkEventDatabaseIntegrity } from "@/services/storage/event-index";

test("Decimal domain keeps financial precision outside JS number arithmetic", () => {
  const capacity = calculateCapacity("1023.000000", "1000.000000");
  assert.equal(capacity.postDepositTvl, "2023.000000000000");
  assert.equal(estimateLpFee("119.76", "1023", "1000"), "59.199209095403");
});

test("null semantics preserves measured zero and removes only missing placeholders", () => {
  const value = normalizeNullSemantics({ zero: 0, missing: undefined, placeholder: "-", finite: 42.5 });
  assert.deepEqual(value, { zero: 0, missing: null, placeholder: null, finite: 42.5 });
  assert.equal(MetricValueSchema.parse({ value: 0, status: "READY", reason: null, asOf: null, coverage: 0 }).value, 0);
});

test("MarketProjection rejects an older REST snapshot after a newer projection", () => {
  assert.equal(acceptsProjectionUpdate({ projectionVersion: 8, sourceTimestamp: "2026-08-06T03:00:00.000Z" }, { projectionVersion: 9, sourceTimestamp: "2026-08-06T02:59:59.000Z" }), false);
  assert.equal(acceptsProjectionUpdate({ projectionVersion: 8, sourceTimestamp: "2026-08-06T03:00:00.000Z" }, { projectionVersion: 9, sourceTimestamp: "2026-08-06T03:00:01.000Z" }), true);
});

test("local database has immutable migration checksum and a recoverable projection", () => {
  const integrity = checkEventDatabaseIntegrity();
  assert.equal(integrity.ok, true);
  assert.ok(integrity.migrations.some((item) => item.id === "0001_architecture_runtime.sql" && item.sha256.length === 64));
  const projection = readMarketProjection();
  assert.ok(projection);
  assert.ok(projection.projectionVersion >= 0);
});
