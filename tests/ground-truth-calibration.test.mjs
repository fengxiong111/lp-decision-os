import assert from "node:assert/strict";
import test from "node:test";
import { U128, coverageIsComplete, currentOwed, feeGrowthInside, identityKey } from "../services/raydium/math.mjs";

for (let index = 0; index < 48; index += 1) {
  test(`fee-growth-inside boundary case ${index + 1}`, () => {
    const global = BigInt(index + 100) * 1_000_000n;
    const lowerOutside = BigInt(index + 3) * 10_000n;
    const upperOutside = BigInt(index + 7) * 20_000n;
    const lower = -120 + index;
    const upper = lower + 60;
    const current = index % 3 === 0 ? lower - 1 : index % 3 === 1 ? lower : upper;
    const below = current >= lower ? lowerOutside : (global - lowerOutside + U128) % U128;
    const above = current < upper ? upperOutside : (global - upperOutside + U128) % U128;
    const expected = (global - below - above + U128 * 2n) % U128;
    assert.equal(feeGrowthInside(global, lowerOutside, upperOutside, current, lower, upper), expected);
  });
}

for (let index = 0; index < 32; index += 1) {
  test(`position fee owed exact Q64.64 case ${index + 1}`, () => {
    const liquidity = BigInt(index + 1) * 10_000_000n;
    const inside = BigInt(index + 10) * 1_000_000_000n;
    const last = BigInt(index + 2) * 100_000_000n;
    const owed = BigInt(index);
    const expected = owed + (liquidity * ((inside - last + U128) % U128)) / (1n << 64n);
    assert.equal(currentOwed(liquidity, inside, last, owed), expected);
  });
}

for (let index = 0; index < 20; index += 1) {
  test(`window completeness fail-closed case ${index + 1}`, () => {
    const complete = { backfillStatus: "COMPLETE", coverageRatio: 100, gapSlots: 0, unknownInstructions: 0 };
    assert.equal(coverageIsComplete(complete), true);
    assert.equal(coverageIsComplete({ ...complete, coverageRatio: 99 }), false);
    assert.equal(coverageIsComplete({ ...complete, gapSlots: index % 2 }), index % 2 === 0);
    assert.equal(coverageIsComplete({ ...complete, unknownInstructions: index % 2 }), index % 2 === 0);
  });
}

for (let index = 0; index < 20; index += 1) {
  test(`identity key never collapses distinct Pool/NFT ${index + 1}`, () => {
    const baseMint = `base-${index}`;
    const quoteMint = "USDC";
    const poolAddress = `pool-${index}`;
    const first = identityKey({ baseMint, quoteMint, poolAddress, positionNftMint: "nft-a" });
    const second = identityKey({ baseMint, quoteMint, poolAddress: `${poolAddress}-other`, positionNftMint: "nft-a" });
    const third = identityKey({ baseMint, quoteMint, poolAddress, positionNftMint: "nft-b" });
    assert.notEqual(first, second);
    assert.notEqual(first, third);
  });
}
