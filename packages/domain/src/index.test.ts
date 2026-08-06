import assert from "node:assert/strict";
import test from "node:test";
import { calculateCapacity, decimalString, estimateLpFee } from "./index";

test("Decimal capacity preserves large and small values", () => {
  assert.equal(decimalString("1000.123456789123", 12), "1000.123456789123");
  const capacity = calculateCapacity("1023.000000", "1000.000000");
  assert.equal(capacity.postDepositTvl, "2023.000000000000");
  assert.equal(capacity.status, "SAFE");
  assert.equal(estimateLpFee("119.76", "1023", "1000"), "59.199209095403");
});
