import assert from "node:assert/strict";
import test from "node:test";
import { defaultResearchFilterReason, passesDefaultResearchFilters } from "@/services/rankings";

test("default research filters require all three 24h conditions", () => {
  assert.equal(passesDefaultResearchFilters({ volume24h: 1_001, lpFee24h: 30.01, tvl: 5_000.01 }), true);
  assert.equal(passesDefaultResearchFilters({ volume24h: 1_000, lpFee24h: 30.01, tvl: 5_000.01 }), false);
  assert.equal(passesDefaultResearchFilters({ volume24h: 1_001, lpFee24h: 30, tvl: 5_000.01 }), false);
  assert.equal(passesDefaultResearchFilters({ volume24h: 1_001, lpFee24h: 30.01, tvl: 5_000 }), false);
});

test("filter failure reports every missing condition and treats null as missing", () => {
  assert.equal(
    defaultResearchFilterReason({ volume24h: null, lpFee24h: 30, tvl: 5_000 }),
    "未满足默认筛选：24h成交量 > 1,000、24h LP Fee > 30、TVL > 5,000",
  );
});
