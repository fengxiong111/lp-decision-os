export declare const U64: bigint;
export declare const U128: bigint;
export declare function modulo128(value: bigint): bigint;
export declare function feeGrowthInside(global: bigint, lowerOutside: bigint, upperOutside: bigint, currentTick: number, lower: number, upper: number): bigint;
export declare function currentOwed(liquidity: bigint, inside: bigint, last: bigint, owed: bigint): bigint;
export declare function coverageIsComplete(coverage: { backfillStatus?: string; windowStart?: string | null; oldestCoveredAt?: string | null; oldestCoveredBlockTime?: string | null; unresolvedRetryableTransactions?: number | null; gapCount?: number | null; gapSlots?: number | null; metricsBucketCount?: number | null; expectedBucketCount?: number | null } | null | undefined): boolean;
export declare function identityKey(input: { baseMint: string; quoteMint: string; poolAddress: string; positionNftMint?: string | null }): string;
