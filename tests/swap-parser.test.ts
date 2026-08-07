import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseProgramTransaction } from "@/services/rpc/pool";

type Fixture = {
  signature: string;
  source: string;
  expected: {
    poolAddress: string;
    programId: string;
    baseMint: string;
    quoteMint: string;
    inputMint: string;
    outputMint: string;
    amountInAtomic: string;
    amountOutAtomic: string;
    volumeUsd: number;
    feeStatus: string;
    feeUsd: number | null;
  };
  pool: {
    id: string;
    programId: string;
    poolKind: "CLMM";
    vaultA: string;
    vaultB: string;
    assetMint: string;
    quoteMint: string;
    currentPrice: number;
    feeRate: number;
    hasDynamicFee: boolean;
  };
  transaction: unknown;
};

const fixturePath = path.join(process.cwd(), "tests", "fixtures", "solana-transactions", "raydium-recovery-real.json");
const fixtureFile = JSON.parse(readFileSync(fixturePath, "utf8")) as { fixtures: Fixture[] };

test("real Solana recovery fixtures contain 20 SPCX and 20 SPCXx swaps", () => {
  assert.equal(fixtureFile.fixtures.filter((item) => item.expected.poolAddress === "FjuBy7jjf9DXj9d3R7cHpvcnoFW2iQxf7F7P3vqx4Jza").length, 20);
  assert.equal(fixtureFile.fixtures.filter((item) => item.expected.poolAddress === "AHNN6JmvaGG6XUoSg7sEr38gRYDB2jTbUvqXVuqaRHpq").length, 20);
  assert.ok(fixtureFile.fixtures.every((item) => item.source.includes("real cached Solana RPC")));
});

test("parser preserves actual amount direction and fixed fee on every real fixture", () => {
  for (const fixture of fixtureFile.fixtures) {
    const result = parseProgramTransaction(fixture.pool, fixture.signature, fixture.transaction as never, "2026-08-06T05:00:00.000Z");
    assert.equal(result.matched, true, fixture.signature);
    assert.equal(result.events.length, 1, fixture.signature);
    const event = result.events[0];
    assert.ok(event);
    assert.equal(event.poolId, fixture.expected.poolAddress);
    assert.equal(event.programVersion, fixture.expected.programId);
    assert.equal(event.inputMint, fixture.expected.inputMint);
    assert.equal(event.outputMint, fixture.expected.outputMint);
    assert.equal(event.actualAmountInAtomic, fixture.expected.amountInAtomic);
    assert.equal(event.actualAmountOutAtomic, fixture.expected.amountOutAtomic);
    assert.ok(Math.abs(event.volume - fixture.expected.volumeUsd) <= 0.000001, fixture.signature);
    assert.equal(result.classifications[0]?.errorCategory, "PARSED_SWAP", fixture.signature);
  }
});

test("target-pool matching does not treat a different Pool as a parser failure", () => {
  const fixture = fixtureFile.fixtures.find((item) => item.expected.poolAddress === "AHNN6JmvaGG6XUoSg7sEr38gRYDB2jTbUvqXVuqaRHpq");
  assert.ok(fixture);
  const wrongPool = { ...fixture.pool, id: "FjuBy7jjf9DXj9d3R7cHpvcnoFW2iQxf7F7P3vqx4Jza" };
  const result = parseProgramTransaction(wrongPool, fixture.signature, fixture.transaction as never, "2026-08-06T05:00:00.000Z");
  assert.equal(result.matched, false);
  assert.equal(result.classifications[0]?.errorCategory, "NOT_TARGET_POOL");
});
