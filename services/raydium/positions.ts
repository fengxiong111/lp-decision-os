import type { PoolSnapshot, PositionSnapshot } from "@/packages/models/src";
import { RAYDIUM_PROGRAMS, TOKEN_PROGRAM_IDS, USDC_MINT } from "@/services/raydium/config";
import { rpcRequest, type RpcProvider } from "@/services/rpc/pool";
import { currentOwed, feeGrowthInside } from "@/services/raydium/math.mjs";

const TICK_STATE_SIZE = 136;
const TICK_ARRAY_SIZE = 60;
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

type ProgramAccount = {
  pubkey?: string;
  account?: { owner?: string; data?: unknown };
};

type TokenAccountResponse = {
  value?: Array<{
    pubkey?: string;
    account?: {
      data?: {
        parsed?: {
          info?: {
            mint?: string;
            tokenAmount?: { amount?: string; decimals?: number };
          };
        };
      };
    };
  }>;
};

type PositionState = {
  accountAddress: string;
  positionNftMint: string;
  poolId: string;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  feeGrowthInsideLast0X64: bigint;
  feeGrowthInsideLast1X64: bigint;
  tokenFeesOwed0: bigint;
  tokenFeesOwed1: bigint;
  rewardAmountOwed: bigint[];
  firstSeenSlot: number | null;
  firstSeenAt: string | null;
};

type PoolFeeState = {
  poolId: string;
  token0Mint: string;
  token1Mint: string;
  decimals0: number;
  decimals1: number;
  currentTick: number;
  sqrtPriceX64: bigint;
  feeGrowthGlobal0X64: bigint;
  feeGrowthGlobal1X64: bigint;
  lowerOutside0X64: bigint;
  lowerOutside1X64: bigint;
  upperOutside0X64: bigint;
  upperOutside1X64: bigint;
  error: string | null;
};

export type RawClmmPosition = PositionState & {
  poolState: PoolFeeState;
  feeGrowthInside0CurrentX64: bigint | null;
  feeGrowthInside1CurrentX64: bigint | null;
  tokenFeesOwed0Current: bigint | null;
  tokenFeesOwed1Current: bigint | null;
  readError: string | null;
};

function base58Encode(value: Uint8Array): string {
  let number = 0n;
  for (const byte of value) number = (number << 8n) + BigInt(byte);
  let result = "";
  while (number > 0n) {
    const remainder = Number(number % 58n);
    result = BASE58_ALPHABET[remainder] + result;
    number /= 58n;
  }
  for (const byte of value) {
    if (byte !== 0) break;
    result = `1${result}`;
  }
  return result || "1";
}

function readU64(data: Buffer, offset: number): bigint {
  return data.readBigUInt64LE(offset);
}

function readU128(data: Buffer, offset: number): bigint {
  let value = 0n;
  for (let index = 15; index >= 0; index -= 1) value = (value << 8n) + BigInt(data[offset + index] ?? 0);
  return value;
}

function readI32(data: Buffer, offset: number): number {
  return data.readInt32LE(offset);
}

function readPubkey(data: Buffer, offset: number): string {
  return base58Encode(data.subarray(offset, offset + 32));
}

function accountBytes(account: ProgramAccount["account"] | null | undefined): Buffer | null {
  const value = account?.data;
  if (!Array.isArray(value) || typeof value[0] !== "string") return null;
  try {
    return Buffer.from(value[0], "base64");
  } catch {
    return null;
  }
}

function parsePositionAccount(accountAddress: string, bytes: Buffer, nftMint: string): PositionState | null {
  // Anchor discriminator (8) + PersonalPositionState fields from the official CLMM account layout.
  if (bytes.length < 281 || bytes.length < 9 + 32 + 32 + 4 + 4 + 16 + 16 + 16 + 8 + 8 + 72 + 8 + 56) return null;
  let offset = 8;
  offset += 1; // bump
  const accountNftMint = readPubkey(bytes, offset);
  offset += 32;
  const poolId = readPubkey(bytes, offset);
  offset += 32;
  const tickLower = readI32(bytes, offset);
  offset += 4;
  const tickUpper = readI32(bytes, offset);
  offset += 4;
  const liquidity = readU128(bytes, offset);
  offset += 16;
  const feeGrowthInsideLast0X64 = readU128(bytes, offset);
  offset += 16;
  const feeGrowthInsideLast1X64 = readU128(bytes, offset);
  offset += 16;
  const tokenFeesOwed0 = readU64(bytes, offset);
  offset += 8;
  const tokenFeesOwed1 = readU64(bytes, offset);
  offset += 8;
  const rewardAmountOwed: bigint[] = [];
  for (let index = 0; index < 3; index += 1) {
    offset += 16; // growth_inside_last_x64
    rewardAmountOwed.push(readU64(bytes, offset));
    offset += 8;
  }
  // recent_epoch and padding are intentionally not used for valuation.
  if (accountNftMint !== nftMint || tickLower >= tickUpper) return null;
  return {
    accountAddress,
    positionNftMint: accountNftMint,
    poolId,
    tickLower,
    tickUpper,
    liquidity,
    feeGrowthInsideLast0X64,
    feeGrowthInsideLast1X64,
    tokenFeesOwed0,
    tokenFeesOwed1,
    rewardAmountOwed,
    firstSeenSlot: null,
    firstSeenAt: null,
  };
}

function parsePoolState(poolId: string, bytes: Buffer): PoolFeeState | null {
  // Current PoolState offsets are fixed by the Raydium CLMM Anchor account layout.
  if (bytes.length < 310) return null;
  const token0Mint = readPubkey(bytes, 8 + 1 + 32 + 32);
  const token1Mint = readPubkey(bytes, 8 + 1 + 32 + 32 + 32);
  const decimals0 = bytes[8 + 1 + 32 + 32 + 32 + 32 + 32 + 32 + 32] ?? 0;
  const decimals1 = bytes[8 + 1 + 32 + 32 + 32 + 32 + 32 + 32 + 32 + 1] ?? 0;
  const currentTick = readI32(bytes, 269);
  const sqrtPriceX64 = readU128(bytes, 253);
  const feeGrowthGlobal0X64 = readU128(bytes, 277);
  const feeGrowthGlobal1X64 = readU128(bytes, 293);
  return {
    poolId,
    token0Mint,
    token1Mint,
    decimals0,
    decimals1,
    currentTick,
    sqrtPriceX64,
    feeGrowthGlobal0X64,
    feeGrowthGlobal1X64,
    lowerOutside0X64: 0n,
    lowerOutside1X64: 0n,
    upperOutside0X64: 0n,
    upperOutside1X64: 0n,
    error: null,
  };
}

function parseTickOutside(bytes: Buffer, targetTick: number): { outside0: bigint; outside1: bigint } | null {
  if (bytes.length < 44 + TICK_ARRAY_SIZE * TICK_STATE_SIZE) return null;
  const startTick = readI32(bytes, 40);
  for (let index = 0; index < TICK_ARRAY_SIZE; index += 1) {
    const offset = 44 + index * TICK_STATE_SIZE;
    if (readI32(bytes, offset) !== targetTick) continue;
    return { outside0: readU128(bytes, offset + 36), outside1: readU128(bytes, offset + 52) };
  }
  // `startTick` is read above as a layout check; a missing target is a hard data failure.
  void startTick;
  return null;
}

async function readFirstSeen(provider: RpcProvider, accountAddress: string): Promise<{ slot: number | null; blockTime: string | null }> {
  const response = await rpcRequest<Array<{ slot?: number; blockTime?: number | null; err?: unknown }>>(provider, "getSignaturesForAddress", [accountAddress, { limit: 1000, commitment: "confirmed" }]);
  const valid = (response.result ?? []).filter((item) => item.err === null || item.err === undefined);
  const oldest = valid.at(-1);
  return {
    slot: typeof oldest?.slot === "number" ? oldest.slot : null,
    blockTime: typeof oldest?.blockTime === "number" ? new Date(oldest.blockTime * 1000).toISOString() : null,
  };
}

async function readPoolFeeState(provider: RpcProvider, poolId: string, lower: number, upper: number, cache: Map<string, PoolFeeState>): Promise<PoolFeeState> {
  const cacheKey = `${poolId}:${lower}:${upper}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const poolResponse = await rpcRequest<{ value?: ProgramAccount["account"] | null }>(provider, "getAccountInfo", [poolId, { encoding: "base64", commitment: "confirmed" }]);
  const poolBytes = accountBytes(poolResponse.result?.value);
  const base = poolBytes ? parsePoolState(poolId, poolBytes) : null;
  if (!base) {
    const failed = { poolId, token0Mint: "", token1Mint: "", decimals0: 0, decimals1: 0, currentTick: 0, sqrtPriceX64: 0n, feeGrowthGlobal0X64: 0n, feeGrowthGlobal1X64: 0n, lowerOutside0X64: 0n, lowerOutside1X64: 0n, upperOutside0X64: 0n, upperOutside1X64: 0n, error: poolResponse.error ?? "PoolState 解码失败" } satisfies PoolFeeState;
    cache.set(cacheKey, failed);
    return failed;
  }
  const tickResponse = await rpcRequest<ProgramAccount[]>(provider, "getProgramAccounts", [RAYDIUM_PROGRAMS.CLMM, { encoding: "base64", commitment: "confirmed", filters: [{ memcmp: { offset: 8, bytes: poolId } }] }]);
  const lowerTick = (tickResponse.result ?? []).flatMap((account) => {
    const bytes = accountBytes(account.account);
    const parsed = bytes ? parseTickOutside(bytes, lower) : null;
    return parsed ? [parsed] : [];
  })[0] ?? null;
  const upperTick = (tickResponse.result ?? []).flatMap((account) => {
    const bytes = accountBytes(account.account);
    const parsed = bytes ? parseTickOutside(bytes, upper) : null;
    return parsed ? [parsed] : [];
  })[0] ?? null;
  const result: PoolFeeState = {
    ...base,
    lowerOutside0X64: lowerTick?.outside0 ?? 0n,
    lowerOutside1X64: lowerTick?.outside1 ?? 0n,
    upperOutside0X64: upperTick?.outside0 ?? 0n,
    upperOutside1X64: upperTick?.outside1 ?? 0n,
    error: tickResponse.error ?? (!lowerTick || !upperTick ? "未找到仓位边界 TickArrayState，不能重算手续费" : null),
  };
  cache.set(cacheKey, result);
  return result;
}

export async function discoverReadOnlyClmmPositions(provider: RpcProvider | null, walletAddress: string | null): Promise<{ positions: RawClmmPosition[]; errors: string[]; observedAt: string }> {
  const observedAt = new Date().toISOString();
  if (!provider) return { positions: [], errors: ["没有可用 RPC"], observedAt };
  if (!walletAddress) return { positions: [], errors: ["未配置 READ_ONLY_SOLANA_ADDRESS"], observedAt };

  const tokenResults = await Promise.all([...TOKEN_PROGRAM_IDS].map((programId) => rpcRequest<TokenAccountResponse>(provider, "getTokenAccountsByOwner", [walletAddress, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }])));
  const errors = tokenResults.flatMap((result) => result.error ? [result.error] : []);
  const nftMints = [...new Set(tokenResults.flatMap((result) => (result.result?.value ?? []).flatMap((account) => {
    const info = account.account?.data?.parsed?.info;
    return info?.mint && info.tokenAmount?.amount === "1" && info.tokenAmount.decimals === 0 ? [info.mint] : [];
  })))];
  if (nftMints.length === 0) return { positions: [], errors: [...errors, "只读钱包没有找到 amount=1、decimals=0 的 Position NFT"], observedAt };

  const states = await Promise.all(nftMints.map(async (nftMint) => {
    const response = await rpcRequest<ProgramAccount[]>(provider, "getProgramAccounts", [RAYDIUM_PROGRAMS.CLMM, { encoding: "base64", commitment: "confirmed", filters: [{ memcmp: { offset: 9, bytes: nftMint } }] }]);
    const account = (response.result ?? []).find((item) => typeof item.pubkey === "string");
    const bytes = account ? accountBytes(account.account) : null;
    const parsed = account?.pubkey && bytes ? parsePositionAccount(account.pubkey, bytes, nftMint) : null;
    if (!parsed) return { parsed: null, error: response.error ?? `Position NFT ${nftMint} 未找到可解码 PersonalPositionState` };
    const firstSeen = await readFirstSeen(provider, parsed.accountAddress);
    return { parsed: { ...parsed, firstSeenSlot: firstSeen.slot, firstSeenAt: firstSeen.blockTime }, error: null };
  }));
  const validStates = states.flatMap((item) => item.parsed ? [item.parsed] : []);
  const stateErrors = states.flatMap((item) => item.error ? [item.error] : []);
  const feeStateCache = new Map<string, PoolFeeState>();
  const positions = await Promise.all(validStates.map(async (position): Promise<RawClmmPosition> => {
    const poolState = await readPoolFeeState(provider, position.poolId, position.tickLower, position.tickUpper, feeStateCache);
    if (poolState.error !== null) return { ...position, poolState, feeGrowthInside0CurrentX64: null, feeGrowthInside1CurrentX64: null, tokenFeesOwed0Current: null, tokenFeesOwed1Current: null, readError: poolState.error };
    const inside0 = feeGrowthInside(poolState.feeGrowthGlobal0X64, poolState.lowerOutside0X64, poolState.upperOutside0X64, poolState.currentTick, position.tickLower, position.tickUpper);
    const inside1 = feeGrowthInside(poolState.feeGrowthGlobal1X64, poolState.lowerOutside1X64, poolState.upperOutside1X64, poolState.currentTick, position.tickLower, position.tickUpper);
    return {
      ...position,
      poolState,
      feeGrowthInside0CurrentX64: inside0,
      feeGrowthInside1CurrentX64: inside1,
      tokenFeesOwed0Current: currentOwed(position.liquidity, inside0, position.feeGrowthInsideLast0X64, position.tokenFeesOwed0),
      tokenFeesOwed1Current: currentOwed(position.liquidity, inside1, position.feeGrowthInsideLast1X64, position.tokenFeesOwed1),
      readError: null,
    };
  }));
  return { positions, errors: [...errors, ...stateErrors], observedAt };
}

function tickSqrtPrice(tick: number): number {
  return Math.sqrt(Math.pow(1.0001, tick));
}

function positionAmounts(position: RawClmmPosition): { amount0: number; amount1: number } {
  if (position.readError || position.liquidity <= 0n) return { amount0: 0, amount1: 0 };
  const liquidity = Number(position.liquidity);
  const current = Number(position.poolState.sqrtPriceX64) / 2 ** 64;
  const lower = tickSqrtPrice(position.tickLower);
  const upper = tickSqrtPrice(position.tickUpper);
  if (![liquidity, current, lower, upper].every(Number.isFinite) || current <= 0 || lower <= 0 || upper <= 0) return { amount0: 0, amount1: 0 };
  if (current <= lower) return { amount0: Math.max(0, liquidity * (upper - lower) / (lower * upper)), amount1: 0 };
  if (current < upper) return { amount0: Math.max(0, liquidity * (upper - current) / (current * upper)), amount1: Math.max(0, liquidity * (current - lower)) };
  return { amount0: 0, amount1: Math.max(0, liquidity * (upper - lower)) };
}

function atomicNumber(value: number): string {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value).toString() : "0";
}

function valueUsd(position: RawClmmPosition, pool: PoolSnapshot | undefined, amount0Atomic: number, amount1Atomic: number, fee0Atomic: bigint | null, fee1Atomic: bigint | null): { positionValueUsd: number | null; feeUsd: number | null } {
  if (!pool) return { positionValueUsd: null, feeUsd: null };
  const token0IsBase = position.poolState.token0Mint === pool.identity.baseMint;
  const baseAtomic = token0IsBase ? amount0Atomic : amount1Atomic;
  const quoteAtomic = token0IsBase ? amount1Atomic : amount0Atomic;
  const baseDecimals = token0IsBase ? position.poolState.decimals0 : position.poolState.decimals1;
  const quoteDecimals = token0IsBase ? position.poolState.decimals1 : position.poolState.decimals0;
  const base = baseAtomic / 10 ** baseDecimals;
  const quote = quoteAtomic / 10 ** quoteDecimals;
  const feeBaseAtomic = token0IsBase ? fee0Atomic : fee1Atomic;
  const feeQuoteAtomic = token0IsBase ? fee1Atomic : fee0Atomic;
  const feeBase = feeBaseAtomic === null ? null : Number(feeBaseAtomic) / 10 ** baseDecimals;
  const feeQuote = feeQuoteAtomic === null ? null : Number(feeQuoteAtomic) / 10 ** quoteDecimals;
  return {
    positionValueUsd: Number.isFinite(base) && Number.isFinite(quote) && pool.currentPrice !== null ? base * pool.currentPrice + quote : null,
    feeUsd: feeBase !== null && feeQuote !== null && pool.currentPrice !== null ? feeBase * pool.currentPrice + feeQuote : null,
  };
}

export function buildPositionSnapshots(rawPositions: RawClmmPosition[], pools: PoolSnapshot[], owner: string, observedAt: string): PositionSnapshot[] {
  return rawPositions.map((position) => {
    const pool = pools.find((item) => item.id === position.poolId);
    const amounts = positionAmounts(position);
    const values = valueUsd(position, pool, amounts.amount0, amounts.amount1, position.tokenFeesOwed0Current, position.tokenFeesOwed1Current);
    const inRange = position.poolState.currentTick >= position.tickLower && position.poolState.currentTick < position.tickUpper;
    return {
      positionNftMint: position.positionNftMint,
      owner,
      poolAddress: position.poolId,
      baseMint: pool?.identity.baseMint ?? (position.poolState.token0Mint === USDC_MINT ? position.poolState.token1Mint : position.poolState.token0Mint),
      quoteMint: pool?.identity.quoteMint ?? USDC_MINT,
      assetSymbol: pool?.asset.symbol ?? null,
      poolKind: "CLMM" as const,
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
      liquidity: position.liquidity.toString(),
      token0Amount: atomicNumber(amounts.amount0),
      token1Amount: atomicNumber(amounts.amount1),
      tokenFeesOwed0: (position.tokenFeesOwed0Current ?? position.tokenFeesOwed0).toString(),
      tokenFeesOwed1: (position.tokenFeesOwed1Current ?? position.tokenFeesOwed1).toString(),
      rewardAmountOwed: position.rewardAmountOwed.map((value) => value.toString()),
      feeGrowthInsideLast0X64: position.feeGrowthInsideLast0X64.toString(),
      feeGrowthInsideLast1X64: position.feeGrowthInsideLast1X64.toString(),
      currentTick: position.poolState.currentTick,
      inRange,
      positionValueUsd: values.positionValueUsd,
      uncollectedFeeUsd: values.feeUsd,
      rewardUsd: null,
      activeSeconds: 0,
      firstSeenSlot: position.firstSeenSlot,
      firstSeenAt: position.firstSeenAt,
      holdBenchmarkValue: null,
      impermanentLoss: null,
      realizedFeeReturn: null,
      actualFeeReturn: null,
      inRangeHourlyFeeRate: null,
      relativeHoldNetReturn: null,
      source: position.readError ? `PersonalPositionState 解码失败：${position.readError}` : "Solana RPC PersonalPositionState + PoolState + TickArrayState",
      observedAt,
    } satisfies PositionSnapshot;
  });
}
