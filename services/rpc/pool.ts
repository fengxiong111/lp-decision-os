import { WINDOW_KEYS, type EventWindowCoverage, type LastSwap, type RpcPoolSnapshot, type ServiceHealth, type SwapErrorCategory, type SwapEventRecord, type TransactionClassification, type WindowKey } from "@/packages/models/src";
import { exponentialBackoffMs, mapWithConcurrency, postJson } from "@/services/shared/http";
import {
  RAYDIUM_PROGRAM_IDS,
  SOLANA_RPC_DEFAULT,
  SOLANA_WS_DEFAULT,
  TOKEN_PROGRAM_IDS,
} from "@/services/raydium/config";
import { persistRpcAccountCache, readRpcAccountCache, persistRpcTransactionCache, readRpcTransactionCache, persistBackfillCheckpoint, readBackfillCheckpoint, persistBackfillSignatures, readBackfillSignatures, type CachedRpcTransaction, type RpcAccountCacheEntry } from "@/services/storage/event-index";

export type RpcProvider = {
  id: string;
  label: string;
  url: string | null;
  wsUrl: string | null;
};

type RpcEnvelope<T> = {
  id?: number;
  result?: T;
  error?: { code?: number; message?: string };
};

type RpcAccount = {
  owner?: string;
  lamports?: number;
  data?: unknown;
  executable?: boolean;
};

type SignatureInfo = {
  signature?: string;
  slot?: number;
  blockTime?: number | null;
  err?: unknown;
};

function splitEndpoints(value: string | undefined): string[] {
  return (value ?? "").split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean);
}

export function getRpcProviders(): RpcProvider[] {
  const customRpc = splitEndpoints(process.env.SOLANA_RPC_URLS);
  const customWs = splitEndpoints(process.env.SOLANA_WS_URLS);
  const providers: RpcProvider[] = [];
  const add = (id: string, label: string, url: string | null, wsUrl: string | null) => {
    if (!providers.some((provider) => provider.url === url && provider.wsUrl === wsUrl)) providers.push({ id, label, url, wsUrl });
  };
  customRpc.forEach((url, index) => add(`custom-${index + 1}`, `自定义 RPC ${index + 1}`, url, customWs[index] ?? null));
  if (process.env.HELIUS_RPC_URL) add("helius", "Helius", process.env.HELIUS_RPC_URL, process.env.HELIUS_WS_URL ?? null);
  if (process.env.QUICKNODE_RPC_URL) add("quicknode", "QuickNode", process.env.QUICKNODE_RPC_URL, process.env.QUICKNODE_WS_URL ?? null);
  if (process.env.ALCHEMY_RPC_URL) add("alchemy", "Alchemy", process.env.ALCHEMY_RPC_URL, process.env.ALCHEMY_WS_URL ?? null);
  if (process.env.SOLANA_RPC_FALLBACK_URL) add("configured-fallback", "用户配置备用 RPC", process.env.SOLANA_RPC_FALLBACK_URL, process.env.SOLANA_WS_FALLBACK_URL ?? null);
  // 官方公共端点永远是最后兜底。只有显式配置的端点才会在它之前参与选择。
  add("official", "官方 Solana RPC（最后兜底）", process.env.SOLANA_RPC_URL ?? SOLANA_RPC_DEFAULT, process.env.SOLANA_WS_URL ?? SOLANA_WS_DEFAULT);
  return providers;
}

export function hasConfiguredReliableRpc(): boolean {
  const explicitSingle = process.env.SOLANA_RPC_URL?.trim();
  return getRpcProviders().some((provider) => provider.id !== "official")
    || Boolean(explicitSingle && explicitSingle !== SOLANA_RPC_DEFAULT);
}

type EndpointState = { failures: number; cooldownUntil: number; lastError: string | null; lastSuccessAt: string | null };
const endpointStates = new Map<string, EndpointState>();

function endpointState(provider: RpcProvider): EndpointState {
  const key = provider.url ?? provider.id;
  const existing = endpointStates.get(key);
  if (existing) return existing;
  const created = { failures: 0, cooldownUntil: 0, lastError: null, lastSuccessAt: null };
  endpointStates.set(key, created);
  return created;
}

function markEndpointSuccess(provider: RpcProvider) {
  const state = endpointState(provider);
  state.failures = 0;
  state.cooldownUntil = 0;
  state.lastError = null;
  state.lastSuccessAt = checkedAt();
}

function markEndpointFailure(provider: RpcProvider, error: string) {
  const state = endpointState(provider);
  state.failures += 1;
  state.lastError = error;
  // 429 明确冷却 60 秒；其它网络错误仍使用指数熔断。
  const cooldownMs = /(?:HTTP\s*)?429/i.test(error)
    ? 60_000
    : Math.min(120_000, 5_000 * (2 ** Math.max(0, state.failures - 1)));
  state.cooldownUntil = Date.now() + cooldownMs;
}

const checkedAt = () => new Date().toISOString();

export async function rpcRequest<T>(provider: RpcProvider, method: string, params: unknown[] = [], timeoutMs = 8_000): Promise<{ result: T | null; latencyMs: number | null; error: string | null }> {
  if (!provider.url) return { result: null, latencyMs: null, error: "未配置 URL" };
  const state = endpointState(provider);
  if (state.cooldownUntil > Date.now()) {
    return { result: null, latencyMs: null, error: `熔断中，${Math.ceil((state.cooldownUntil - Date.now()) / 1000)} 秒后探测` };
  }
  let response = await postJson<RpcEnvelope<T>>(provider.url, {
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  }, timeoutMs, { rateKey: `rpc:${method}`, logicalMethod: method });
  for (let attempt = 0; attempt < 6 && response.meta.status === 429; attempt += 1) {
    const waitMs = Math.max(exponentialBackoffMs(attempt), response.meta.retryAfterMs ?? 0);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    response = await postJson<RpcEnvelope<T>>(provider.url, {
      jsonrpc: "2.0",
      id: attempt + 2,
      method,
      params,
    }, timeoutMs, { rateKey: `rpc:${method}`, logicalMethod: method });
  }
  if (response.meta.error) {
    markEndpointFailure(provider, response.meta.error);
    return { result: null, latencyMs: response.meta.latencyMs, error: response.meta.error };
  }
  if (!response.data || response.data.error) {
    const error = response.data?.error?.message ?? "RPC 返回错误";
    markEndpointFailure(provider, error);
    return { result: null, latencyMs: response.meta.latencyMs, error };
  }
  markEndpointSuccess(provider);
  return { result: response.data.result ?? null, latencyMs: response.meta.latencyMs, error: null };
}

export async function rpcBatchRequest<T>(provider: RpcProvider, calls: Array<{ id: number; method: string; params: unknown[] }>, timeoutMs = 20_000): Promise<Array<{ id: number; result: T | null; error: string | null }>> {
  if (!provider.url || calls.length === 0) return calls.map((call) => ({ id: call.id, result: null, error: "未配置 URL" }));
  const method = calls[0]?.method ?? "rpc";
  let response = await postJson<Array<RpcEnvelope<T>>>(provider.url, calls.map((call) => ({ jsonrpc: "2.0", id: call.id, method: call.method, params: call.params })), timeoutMs, { rateKey: `rpc:${method}`, rateCost: calls.length, logicalMethod: method, logicalCount: calls.length });
  for (let attempt = 0; attempt < 6 && response.meta.status === 429; attempt += 1) {
    const waitMs = Math.max(exponentialBackoffMs(attempt), response.meta.retryAfterMs ?? 0);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    response = await postJson<Array<RpcEnvelope<T>>>(provider.url, calls.map((call) => ({ jsonrpc: "2.0", id: call.id, method: call.method, params: call.params })), timeoutMs, { rateKey: `rpc:${method}`, rateCost: calls.length, logicalMethod: method, logicalCount: calls.length });
  }
  if (response.meta.error || !response.data) {
    const error = response.meta.error ?? "RPC 批量请求失败";
    markEndpointFailure(provider, error);
    return calls.map((call) => ({ id: call.id, result: null, error }));
  }
  markEndpointSuccess(provider);
  const byId = new Map(response.data.map((item) => [item && typeof item === "object" && "id" in item && typeof item.id === "number" ? item.id : -1, item]));
  return calls.map((call) => {
    const item = byId.get(call.id);
    if (!item) return { id: call.id, result: null, error: "批量响应缺少对应 id" };
    return { id: call.id, result: item.result ?? null, error: item.error?.message ?? null };
  });
}

async function probeProvider(provider: RpcProvider): Promise<ServiceHealth & { slot: number | null; provider: RpcProvider }> {
  const now = checkedAt();
  if (!provider.url) {
    return {
      name: provider.id,
      label: provider.label,
      status: "未配置",
      latencyMs: null,
      detail: "等待环境变量配置",
      sourceUrl: null,
      checkedAt: now,
      slot: null,
      provider,
    };
  }
  const response = await rpcRequest<number>(provider, "getSlot", [{ commitment: "processed" }], 3_500);
  return {
    name: provider.id,
    label: provider.label,
    status: response.result === null ? "离线" : "在线",
    latencyMs: response.latencyMs,
    detail: response.result === null ? response.error ?? "RPC 无响应" : `processed slot ${response.result}`,
    sourceUrl: provider.url,
    checkedAt: now,
    slot: response.result,
    provider,
  };
}

export async function getRpcPoolSnapshot(): Promise<RpcPoolSnapshot> {
  const providers = getRpcProviders();
  const probed = await Promise.all(providers.map(probeProvider));
  const healthy = probed.filter((provider) => provider.status === "在线" && provider.slot !== null);
  const providerOrder = new Map(providers.map((provider, index) => [provider.id, index]));
  healthy.sort((a, b) => (providerOrder.get(a.provider.id) ?? Infinity) - (providerOrder.get(b.provider.id) ?? Infinity));
  const active = healthy[0];
  let finalizedSlot: number | null = null;
  if (active) {
    const finalized = await rpcRequest<number>(active.provider, "getSlot", [{ commitment: "finalized" }], 3_500);
    finalizedSlot = finalized.result;
  }
  return {
    activeProvider: active?.label ?? null,
    currentSlot: active?.slot ?? null,
    finalizedSlot,
    slotLag: active?.slot !== null && active?.slot !== undefined && finalizedSlot !== null ? active.slot - finalizedSlot : null,
    providers: probed.map((item) => ({
      name: item.name,
      label: item.label,
      status: item.status,
      latencyMs: item.latencyMs,
      detail: item.detail,
      sourceUrl: item.sourceUrl,
      checkedAt: item.checkedAt,
    })),
  };
}

export function getActiveRpcProvider(snapshot: RpcPoolSnapshot): RpcProvider | null {
  const health = snapshot.providers.find((provider) => provider.label === snapshot.activeProvider && provider.status === "在线");
  return getRpcProviders().find((provider) => provider.label === health?.label) ?? null;
}

export type AccountVerification = {
  exists: boolean;
  owner: string | null;
  lamports: number | null;
  programVerified: boolean;
};

export async function verifyPoolAccounts(
  provider: RpcProvider | null,
  ids: string[],
): Promise<{ accounts: Map<string, AccountVerification>; slot: number | null; error: string | null }> {
  const accounts = new Map<string, AccountVerification>();
  const unique = [...new Set(ids)];
  const cached = readRpcAccountCache(unique, "pool", 10 * 60_000);
  for (const [address, payload] of cached) {
    if (payload && typeof payload === "object") accounts.set(address, payload as AccountVerification);
  }
  const missing = unique.filter((id) => !accounts.has(id));
  if (!provider || missing.length === 0) return { accounts, slot: null, error: provider || accounts.size > 0 ? null : "没有可用 RPC" };
  const chunks: string[][] = [];
  for (let index = 0; index < missing.length; index += 100) chunks.push(missing.slice(index, index + 100));
  const results = await mapWithConcurrency(chunks, 3, async (chunk) => rpcRequest<{ value: (RpcAccount | null)[] }>(provider, "getMultipleAccounts", [chunk, { encoding: "base64", commitment: "confirmed" }]));
  const errors: string[] = [];
  const fetchedAt = new Date().toISOString();
  const cacheEntries: RpcAccountCacheEntry[] = [];
  results.forEach((response, chunkIndex) => {
    if (response.error) errors.push(response.error);
    const values = response.result?.value ?? [];
    values.forEach((account, index) => {
      const owner = typeof account?.owner === "string" ? account.owner : null;
      const verification = {
        exists: account !== null,
        owner,
        lamports: typeof account?.lamports === "number" ? account.lamports : null,
        programVerified: owner !== null && RAYDIUM_PROGRAM_IDS.has(owner),
      } satisfies AccountVerification;
      accounts.set(chunks[chunkIndex][index], verification);
      cacheEntries.push({ address: chunks[chunkIndex][index], kind: "pool", payload: verification, fetchedAt, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
    });
  });
  persistRpcAccountCache(cacheEntries);
  const slotResponse = await rpcRequest<number>(provider, "getSlot", [{ commitment: "confirmed" }]);
  return { accounts, slot: slotResponse.result, error: errors.length > 0 ? errors[0] : null };
}

type ParsedAccount = RpcAccount & {
  data?: {
    parsed?: {
      info?: {
        decimals?: number;
        mint?: string;
        tokenAmount?: { uiAmount?: number | null };
      };
    };
    program?: string;
  };
};

export async function verifyTokenAndVaultAccounts(
  provider: RpcProvider | null,
  addresses: string[],
): Promise<{ accounts: Map<string, { exists: boolean; owner: string | null; decimals: number | null; mint: string | null; tokenProgram: boolean }>; error: string | null }> {
  const result = new Map<string, { exists: boolean; owner: string | null; decimals: number | null; mint: string | null; tokenProgram: boolean }>();
  const unique = [...new Set(addresses)];
  const cached = readRpcAccountCache(unique, "mint", 30 * 60_000);
  for (const [address, payload] of cached) {
    if (payload && typeof payload === "object") result.set(address, payload as { exists: boolean; owner: string | null; decimals: number | null; mint: string | null; tokenProgram: boolean });
  }
  const missing = unique.filter((address) => !result.has(address));
  if (!provider || missing.length === 0) return { accounts: result, error: provider || result.size > 0 ? null : "没有可用 RPC" };
  const chunks: string[][] = [];
  for (let index = 0; index < missing.length; index += 100) chunks.push(missing.slice(index, index + 100));
  const responses = await mapWithConcurrency(chunks, 3, async (chunk) => rpcRequest<{ value: (ParsedAccount | null)[] }>(provider, "getMultipleAccounts", [chunk, { encoding: "jsonParsed", commitment: "confirmed" }]));
  const errors: string[] = [];
  const fetchedAt = new Date().toISOString();
  const cacheEntries: RpcAccountCacheEntry[] = [];
  responses.forEach((response, chunkIndex) => {
    if (response.error) errors.push(response.error);
    const values = response.result?.value ?? [];
    values.forEach((account, index) => {
      const info = account?.data?.parsed?.info;
      const owner = typeof account?.owner === "string" ? account.owner : null;
      const accountState = {
        exists: account !== null,
        owner,
        decimals: typeof info?.decimals === "number" ? info.decimals : null,
        mint: typeof info?.mint === "string" ? info.mint : null,
        tokenProgram: owner !== null && TOKEN_PROGRAM_IDS.has(owner),
      };
      result.set(chunks[chunkIndex][index], accountState);
      cacheEntries.push({ address: chunks[chunkIndex][index], kind: "mint", payload: accountState, fetchedAt, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() });
    });
  });
  persistRpcAccountCache(cacheEntries);
  return { accounts: result, error: errors.length > 0 ? errors[0] : null };
}

export async function findLatestRaydiumSwap(provider: RpcProvider | null, poolIds: string[]): Promise<LastSwap | null> {
  if (!provider || poolIds.length === 0) return null;
  const candidates = await mapWithConcurrency(poolIds.slice(0, 16), 4, async (poolId) => {
    const response = await rpcRequest<SignatureInfo[]>(provider, "getSignaturesForAddress", [poolId, { limit: 12, commitment: "confirmed" }]);
    return { poolId, signatures: response.result ?? [] };
  });
  const transactions = candidates.flatMap(({ poolId, signatures }) =>
    signatures.filter((item) => item.signature && !item.err).map((item) => ({ poolId, item })),
  );
  const checked = await mapWithConcurrency(transactions.slice(0, 36), 6, async ({ poolId, item }) => {
    const startedAt = Date.now();
    const response = await rpcRequest<{ slot?: number; blockTime?: number | null; meta?: { logMessages?: string[] | null } }>(provider, "getTransaction", [item.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
    const logs = response.result?.meta?.logMessages ?? [];
    const isSwap = logs.some((log) => /instruction:\s*swap|raydiumclmmswap|swapevent/i.test(log));
    const result: LastSwap | null = isSwap && item.signature && response.result?.slot
      ? {
          signature: item.signature,
          poolId,
          slot: response.result.slot,
          blockTime: response.result.blockTime ? new Date(response.result.blockTime * 1000).toISOString() : null,
          sourceUrl: provider.url ?? SOLANA_RPC_DEFAULT,
          parsedAt: new Date().toISOString(),
          parseLatencyMs: Date.now() - startedAt,
          persistenceLatencyMs: null,
          persisted: false,
          eventWindow: null,
        }
      : null;
    return result;
  });
  return checked.filter((item): item is LastSwap => item !== null).sort((a, b) => b.slot - a.slot)[0] ?? null;
}

export type SwapWindowPool = {
  id: string;
  vaultA: string | null;
  vaultB: string | null;
  assetMint: string;
  quoteMint: string;
  currentPrice: number | null;
  feeRate: number | null;
  programVersion: string | null;
};

export type RecentSwapEvent = SwapEventRecord;

type TokenBalance = {
  accountIndex?: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: { amount?: string; decimals?: number };
};

function tokenBalanceAmount(balance: TokenBalance | undefined): number {
  const amount = balance?.uiTokenAmount?.amount;
  const decimals = balance?.uiTokenAmount?.decimals;
  if (typeof amount !== "string" || typeof decimals !== "number") return 0;
  try {
    return Number(BigInt(amount)) / 10 ** decimals;
  } catch {
    return 0;
  }
}

function tokenBalanceAtomic(balance: TokenBalance | undefined): bigint {
  const amount = balance?.uiTokenAmount?.amount;
  if (typeof amount !== "string") return 0n;
  try {
    return BigInt(amount);
  } catch {
    return 0n;
  }
}

function balanceDelta(
  pre: TokenBalance[],
  post: TokenBalance[],
  accountIndex: number,
  mint: string,
): number {
  const before = pre.find((item) => item.accountIndex === accountIndex && item.mint === mint);
  const after = post.find((item) => item.accountIndex === accountIndex && item.mint === mint);
  return tokenBalanceAmount(after) - tokenBalanceAmount(before);
}

function balanceDeltaAtomic(
  pre: TokenBalance[],
  post: TokenBalance[],
  accountIndex: number,
  mint: string,
): bigint {
  const before = pre.find((item) => item.accountIndex === accountIndex && item.mint === mint);
  const after = post.find((item) => item.accountIndex === accountIndex && item.mint === mint);
  return tokenBalanceAtomic(after) - tokenBalanceAtomic(before);
}

function keyAtIndex(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "pubkey" in value && typeof value.pubkey === "string") return value.pubkey;
  return null;
}

export async function collectRecentPoolSwapEvents(provider: RpcProvider | null, pools: SwapWindowPool[]): Promise<RecentSwapEvent[]> {
  if (!provider || pools.length === 0) return [];
  const results = await mapWithConcurrency(pools, 4, async (pool) => {
    if (!pool.vaultA && !pool.vaultB) return [];
    const signatures = await rpcRequest<SignatureInfo[]>(provider, "getSignaturesForAddress", [pool.id, { limit: 6, commitment: "confirmed" }]);
    const candidates = (signatures.result ?? []).filter((item) => item.signature && !item.err).slice(0, 6);
    const transactions = await mapWithConcurrency(candidates, 4, async (item) => {
      const startedAt = Date.now();
      const response = await rpcRequest<{
        slot?: number;
        blockTime?: number | null;
        transaction?: { message?: { accountKeys?: unknown[] } };
        meta?: { logMessages?: string[] | null; preTokenBalances?: TokenBalance[] | null; postTokenBalances?: TokenBalance[] | null };
      }>(provider, "getTransaction", [item.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
      return { item, transaction: response.result, parseLatencyMs: Date.now() - startedAt };
    });
    return transactions.flatMap(({ item, transaction, parseLatencyMs }) => {
      if (!transaction || typeof transaction.slot !== "number" || typeof transaction.blockTime !== "number") return [];
      const logs = transaction.meta?.logMessages ?? [];
      if (!logs.some((log) => /instruction:\s*swap|raydiumclmmswap|swapevent/i.test(log))) return [];
      const keys = (transaction.transaction?.message?.accountKeys ?? []).map(keyAtIndex);
      const pre = transaction.meta?.preTokenBalances ?? [];
      const post = transaction.meta?.postTokenBalances ?? [];
      const vaultIndexes = [pool.vaultA, pool.vaultB]
        .filter((address): address is string => Boolean(address))
        .map((address) => ({ index: keys.indexOf(address), address }))
        .filter((item) => item.index >= 0);
      if (vaultIndexes.length === 0) return [];
      const quoteDelta = vaultIndexes.reduce((total, item) => total + balanceDelta(pre, post, item.index, pool.quoteMint), 0);
      const assetDelta = vaultIndexes.reduce((total, item) => total + balanceDelta(pre, post, item.index, pool.assetMint), 0);
      const quoteDeltaAtomic = vaultIndexes.reduce((total, item) => total + balanceDeltaAtomic(pre, post, item.index, pool.quoteMint), 0n);
      const assetDeltaAtomic = vaultIndexes.reduce((total, item) => total + balanceDeltaAtomic(pre, post, item.index, pool.assetMint), 0n);
      const volume = Math.abs(quoteDelta) > 0 ? Math.abs(quoteDelta) : Math.abs(assetDelta) * (pool.currentPrice ?? 0);
      if (!Number.isFinite(volume) || volume <= 0) return [];
      const inputIsQuote = quoteDeltaAtomic > 0n;
      const inputAtomic = inputIsQuote ? quoteDeltaAtomic : assetDeltaAtomic;
      const outputAtomic = inputIsQuote ? assetDeltaAtomic : quoteDeltaAtomic;
      return [{
        poolId: pool.id,
        signature: item.signature as string,
        slot: transaction.slot,
        blockTime: new Date(transaction.blockTime * 1000).toISOString(),
        volume,
        // 交易费必须来自 Swap 指令/PoolState；不能用 volume × 页面 Fee Tier 代替。
        fee: null,
        parsedAt: new Date().toISOString(),
        persistedAt: null,
        parseLatencyMs,
        persistenceLatencyMs: null,
        source: "rpc-replay" as const,
        programVersion: pool.programVersion,
        inputMint: inputIsQuote ? pool.quoteMint : pool.assetMint,
        outputMint: inputIsQuote ? pool.assetMint : pool.quoteMint,
        actualAmountInAtomic: inputAtomic > 0n ? inputAtomic.toString() : null,
        actualAmountOutAtomic: outputAtomic < 0n ? (-outputAtomic).toString() : outputAtomic > 0n ? outputAtomic.toString() : null,
        baseFeeRate: pool.feeRate,
        dynamicFeeRate: null,
        effectiveFeeRate: null,
        grossTradeFeeAtomic: null,
        protocolFeeAtomic: null,
        fundFeeAtomic: null,
        lpFeeAtomic: null,
        token2022TransferFeeAtomic: null,
        priceUsd: pool.currentPrice,
        feeUsd: null,
      }];
    });
  });
  return results.flat().sort((a, b) => b.slot - a.slot);
}

export type SwapCollectionResult = {
  events: RecentSwapEvent[];
  coverage: Record<string, Record<WindowKey, EventWindowCoverage>>;
  completePoolIds: string[];
  errors: string[];
};

export type ProgramBackfillPool = {
  id: string;
  programId: string;
  poolKind: "CLMM" | "CPMM" | "AMM v4" | null;
  vaultA: string | null;
  vaultB: string | null;
  assetMint: string;
  quoteMint: string;
  currentPrice: number | null;
  feeRate: number | null;
  hasDynamicFee: boolean;
};

export type HistoricalTransaction = {
  slot?: number;
  blockTime?: number | null;
  transaction?: {
    version?: string | number | null;
    message?: { accountKeys?: unknown[]; instructions?: unknown[]; addressTableLookups?: unknown[] };
  };
  meta?: {
    err?: unknown;
    logMessages?: string[] | null;
    preTokenBalances?: TokenBalance[] | null;
    postTokenBalances?: TokenBalance[] | null;
    loadedAddresses?: { writable?: string[]; readonly?: string[] };
    innerInstructions?: unknown[] | null;
  };
};

type ProgramBackfillOptions = {
  now?: Date;
  hours?: number;
  pageLimit?: number;
  maxPages?: number;
  maxTransactions?: number;
  batchSize?: number;
  targetWindow?: WindowKey;
  targetPoolIds?: string[];
  poolTier?: number;
};

export type ProgramBackfillResult = {
  events: RecentSwapEvent[];
  coverage: Record<string, Record<WindowKey, EventWindowCoverage>>;
  signaturesDiscovered: number;
  transactionsFetched: number;
  transactionsSuccessful: number;
  transactionsFailed: number;
  unknownInstructions: number;
  complete: boolean;
  errors: string[];
  provider: string | null;
};

const PARSER_VERSION = "raydium-swap-parser-v2";

function transactionAccounts(transaction: HistoricalTransaction): string[] {
  const staticKeys = (transaction.transaction?.message?.accountKeys ?? []).map(keyAtIndex).filter((key): key is string => Boolean(key));
  const loaded = transaction.meta?.loadedAddresses;
  return [...staticKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
}

type ParsedInstruction = {
  index: number;
  programId: string | null;
  accounts: string[];
  data: string | null;
};

type SwapParseContext = {
  pool: ProgramBackfillPool;
  signature: string;
  transaction: HistoricalTransaction;
  receivedAt: string;
  keys: string[];
  instruction: ParsedInstruction;
  discriminator: string | null;
  accountCount: number;
  transferDeltas?: Map<string, bigint>;
};

type SwapParseOutput = {
  event: RecentSwapEvent | null;
  classification: TransactionClassification;
};

function transactionVersion(transaction: HistoricalTransaction): string | number | null {
  const version = transaction.transaction?.version;
  return typeof version === "string" || typeof version === "number" ? version : null;
}

function instructionRecord(value: unknown, index: number, keys: string[]): ParsedInstruction {
  if (typeof value !== "object" || value === null) return { index, programId: null, accounts: [], data: null };
  const item = value as Record<string, unknown>;
  const programId = typeof item.programId === "string" ? item.programId : null;
  const accounts = Array.isArray(item.accounts)
    ? item.accounts.flatMap((account) => {
      if (typeof account === "number") return keys[account] ? [keys[account]] : [];
      return keyAtIndex(account) ? [keyAtIndex(account) as string] : [];
    })
    : [];
  const data = typeof item.data === "string" ? item.data : null;
  return { index, programId, accounts, data };
}

function transactionInstructions(transaction: HistoricalTransaction, keys: string[]): ParsedInstruction[] {
  const values = transaction.transaction?.message?.instructions ?? [];
  return values.map((value, index) => instructionRecord(value, index, keys));
}

function innerInstructions(transaction: HistoricalTransaction, keys: string[]): ParsedInstruction[] {
  const rows = transaction.meta?.innerInstructions ?? [];
  return rows.flatMap((row, rowIndex) => {
    if (typeof row !== "object" || row === null) return [];
    const source = row as Record<string, unknown>;
    const instructions = source.instructions;
    if (!Array.isArray(instructions)) return [];
    const parentIndex = typeof source.index === "number" ? source.index : rowIndex;
    return instructions.map((value, instructionIndex) => instructionRecord(value, 1_000 + parentIndex * 100 + instructionIndex, keys));
  });
}

function innerInstructionAccounts(transaction: HistoricalTransaction, keys: string[]): string[] {
  return innerInstructions(transaction, keys).flatMap((item) => item.accounts);
}

function base58Bytes(value: string): number[] {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits = [0];
  for (const char of value) {
    const index = alphabet.indexOf(char);
    if (index < 0) return [];
    let carry = index;
    for (let position = 0; position < digits.length; position += 1) {
      const next = digits[position] * 58 + carry;
      digits[position] = next & 0xff;
      carry = next >> 8;
    }
    while (carry > 0) {
      digits.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of value) if (char === "1") digits.push(0);
  return digits.reverse();
}

function discriminatorFor(instruction: ParsedInstruction, logs: string[]): string | null {
  const log = logs.find((item) => /instruction:\s*(swap|route)|raydium.*swap|swap.?event/i.test(item));
  if (log) {
    const match = log.match(/instruction:\s*([A-Za-z0-9_]+)/i);
    if (match?.[1]) return match[1];
    return log.replace(/^Program log:\s*/i, "").slice(0, 120);
  }
  if (instruction.data) {
    const bytes = base58Bytes(instruction.data).slice(0, 8);
    if (bytes.length > 0) return `0x${bytes.map((item) => item.toString(16).padStart(2, "0")).join("")}`;
  }
  return null;
}

function classify(
  pool: ProgramBackfillPool,
  signature: string,
  transaction: HistoricalTransaction,
  receivedAt: string,
  errorCategory: SwapErrorCategory,
  errorCode: string,
  errorMessage: string,
  extra: Partial<Pick<TransactionClassification, "programId" | "instructionIndex" | "discriminator" | "accountCount">> = {},
): TransactionClassification {
  return {
    signature,
    slot: typeof transaction.slot === "number" ? transaction.slot : null,
    blockTime: typeof transaction.blockTime === "number" ? transaction.blockTime : null,
    poolAddress: pool.id,
    programId: extra.programId ?? pool.programId,
    transactionVersion: transactionVersion(transaction),
    errorCategory,
    errorCode,
    errorMessage,
    retryable: false,
    attemptCount: 1,
    firstSeenAt: receivedAt,
    lastAttemptAt: receivedAt,
    rawTransactionPath: `sqlite://raw_transactions/${signature}`,
    parserVersion: PARSER_VERSION,
    instructionIndex: extra.instructionIndex ?? null,
    discriminator: extra.discriminator ?? null,
    accountCount: extra.accountCount ?? null,
  };
}

type BalanceAggregate = { found: boolean; missingDecimals: boolean; deltaAtomic: bigint; decimals: number | null };

function balanceValue(balance: TokenBalance | undefined): { atomic: bigint; decimals: number } | null {
  const amount = balance?.uiTokenAmount?.amount;
  const decimals = balance?.uiTokenAmount?.decimals;
  if (typeof amount !== "string") return null;
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0) return { atomic: 0n, decimals: -1 };
  try {
    return { atomic: BigInt(amount), decimals };
  } catch {
    return null;
  }
}

function aggregateBalanceDelta(
  pool: ProgramBackfillPool,
  keys: string[],
  pre: TokenBalance[],
  post: TokenBalance[],
  mint: string,
): BalanceAggregate {
  const addresses = [pool.vaultA, pool.vaultB].filter((value): value is string => Boolean(value));
  let indices = addresses.map((address) => keys.indexOf(address)).filter((index) => index >= 0);
  const hasVaultRows = [...pre, ...post].some((row) => typeof row.accountIndex === "number" && indices.includes(row.accountIndex) && row.mint === mint);
  if (!hasVaultRows) {
    indices = [...new Set([...pre, ...post]
      .filter((row) => row.mint === mint && row.owner === pool.id && typeof row.accountIndex === "number")
      .map((row) => row.accountIndex as number))];
  }
  if (indices.length === 0) return { found: false, missingDecimals: false, deltaAtomic: 0n, decimals: null };
  let deltaAtomic = 0n;
  let decimals: number | null = null;
  let found = false;
  let missingDecimals = false;
  for (const index of indices) {
    const before = pre.find((row) => row.accountIndex === index && row.mint === mint);
    const after = post.find((row) => row.accountIndex === index && row.mint === mint);
    const beforeValue = balanceValue(before);
    const afterValue = balanceValue(after);
    if (!beforeValue && !afterValue) continue;
    found = true;
    if (beforeValue?.decimals === -1 || afterValue?.decimals === -1) missingDecimals = true;
    const currentDecimals = beforeValue?.decimals !== undefined && beforeValue.decimals >= 0 ? beforeValue.decimals : afterValue?.decimals;
    if (typeof currentDecimals === "number" && currentDecimals >= 0) decimals = decimals ?? currentDecimals;
    deltaAtomic += (afterValue?.atomic ?? 0n) - (beforeValue?.atomic ?? 0n);
  }
  return { found, missingDecimals, deltaAtomic, decimals };
}

function transferDeltaForPool(transaction: HistoricalTransaction, pool: ProgramBackfillPool): Map<string, bigint> {
  const vaults = new Set([pool.vaultA, pool.vaultB].filter((value): value is string => Boolean(value)));
  const result = new Map<string, bigint>();
  if (vaults.size === 0) return result;
  const rows = transaction.meta?.innerInstructions ?? [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const instructions = (row as Record<string, unknown>).instructions;
    if (!Array.isArray(instructions)) continue;
    for (const value of instructions) {
      if (typeof value !== "object" || value === null) continue;
      const instruction = value as Record<string, unknown>;
      const parsed = typeof instruction.parsed === "object" && instruction.parsed !== null ? instruction.parsed as Record<string, unknown> : null;
      const info = parsed && typeof parsed.info === "object" && parsed.info !== null ? parsed.info as Record<string, unknown> : null;
      const instructionType = parsed && typeof parsed.type === "string" ? parsed.type : "";
      if (!info || !/transfer/i.test(instructionType)) continue;
      const mint = typeof info.mint === "string" ? info.mint : null;
      const source = keyAtIndex(info.source);
      const destination = keyAtIndex(info.destination);
      const amountValue = typeof info.tokenAmount === "object" && info.tokenAmount !== null
        ? (info.tokenAmount as Record<string, unknown>).amount
        : info.amount;
      if (!mint || !source || !destination || typeof amountValue !== "string") continue;
      let amount: bigint;
      try { amount = BigInt(amountValue); } catch { continue; }
      const sign = vaults.has(destination) && !vaults.has(source) ? 1n : vaults.has(source) && !vaults.has(destination) ? -1n : 0n;
      if (sign === 0n) continue;
      result.set(mint, (result.get(mint) ?? 0n) + sign * amount);
    }
  }
  return result;
}

/**
 * 复合交易可能同时包含 Decrease/IncreaseLiquidity、SwapV2 和建仓动作。
 * 全交易 Vault delta 会把这些动作相加，无法再代表某一条 Swap。这里按
 * inner instruction 的父级 CPI 段切分，只汇总目标 Raydium instruction
 * 之后、下一条目标 instruction 之前的 SPL Token transfer。
 */
function transferDeltaForPoolInstruction(transaction: HistoricalTransaction, pool: ProgramBackfillPool, instructionIndex: number, keys: string[]): Map<string, bigint> {
  const vaults = new Set([pool.vaultA, pool.vaultB].filter((value): value is string => Boolean(value)));
  const result = new Map<string, bigint>();
  if (vaults.size === 0) return result;
  const rows = transaction.meta?.innerInstructions ?? [];
  const isOuterInstruction = instructionIndex < 1_000;
  for (const [rowIndex, row] of rows.entries()) {
    if (typeof row !== "object" || row === null) continue;
    const source = row as Record<string, unknown>;
    const instructions = source.instructions;
    if (!Array.isArray(instructions)) continue;
    const parentIndex = typeof source.index === "number" ? source.index : rowIndex;
    let collecting = isOuterInstruction && parentIndex === instructionIndex;
    for (const [childIndex, value] of instructions.entries()) {
      const childInstructionIndex = 1_000 + parentIndex * 100 + childIndex;
      const parsedInstruction = instructionRecord(value, childInstructionIndex, keys);
      if (!isOuterInstruction && parsedInstruction.programId === pool.programId) {
        if (childInstructionIndex === instructionIndex) {
          collecting = true;
          continue;
        }
        if (collecting) break;
        continue;
      }
      if (!collecting || typeof value !== "object" || value === null) continue;
      const instruction = value as Record<string, unknown>;
      const parsed = typeof instruction.parsed === "object" && instruction.parsed !== null ? instruction.parsed as Record<string, unknown> : null;
      const info = parsed && typeof parsed.info === "object" && parsed.info !== null ? parsed.info as Record<string, unknown> : null;
      const instructionType = parsed && typeof parsed.type === "string" ? parsed.type : "";
      if (!info || !/transfer/i.test(instructionType)) continue;
      const mint = typeof info.mint === "string" ? info.mint : null;
      const sourceAddress = keyAtIndex(info.source);
      const destinationAddress = keyAtIndex(info.destination);
      const amountValue = typeof info.tokenAmount === "object" && info.tokenAmount !== null
        ? (info.tokenAmount as Record<string, unknown>).amount
        : info.amount;
      if (!mint || !sourceAddress || !destinationAddress || typeof amountValue !== "string") continue;
      let amount: bigint;
      try { amount = BigInt(amountValue); } catch { continue; }
      const sign = vaults.has(destinationAddress) && !vaults.has(sourceAddress)
        ? 1n
        : vaults.has(sourceAddress) && !vaults.has(destinationAddress)
          ? -1n
          : 0n;
      if (sign === 0n) continue;
      result.set(mint, (result.get(mint) ?? 0n) + sign * amount);
    }
  }
  return result;
}

// Raydium CLMM 的指令数据前缀来自真实 RPC raw transaction。只有在一笔
// 交易同时出现多个目标指令时才使用它缩小候选范围，避免把流动性动作
// 或 Token-2022 建仓动作当成 Swap。wZRp7wZ3 是旧版 Swap，ASCsAbe1 是
// 当前 SwapV2。
const RAYDIUM_CLMM_SWAP_DATA_PREFIXES = ["ASCsAbe1", "wZRp7wZ3"] as const;

function isRaydiumSwapInstruction(instruction: ParsedInstruction): boolean {
  return typeof instruction.data === "string"
    && RAYDIUM_CLMM_SWAP_DATA_PREFIXES.some((prefix) => instruction.data?.startsWith(prefix));
}

function atomicToUnits(value: bigint, decimals: number | null): number | null {
  if (decimals === null || decimals < 0) return null;
  const result = Number(value) / 10 ** decimals;
  return Number.isFinite(result) ? result : null;
}

function feeAtomic(value: bigint, rate: number | null): string | null {
  if (rate === null || !Number.isFinite(rate) || rate < 0) return null;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return null;
  return BigInt(Math.max(0, Math.round(numberValue * rate))).toString();
}

function parseRaydiumSwap(context: SwapParseContext): SwapParseOutput {
  const { pool, signature, transaction, receivedAt, keys, instruction, discriminator, accountCount } = context;
  const pre = transaction.meta?.preTokenBalances ?? [];
  const post = transaction.meta?.postTokenBalances ?? [];
  const quote = aggregateBalanceDelta(pool, keys, pre, post, pool.quoteMint);
  const asset = aggregateBalanceDelta(pool, keys, pre, post, pool.assetMint);
  const extra = { programId: instruction.programId, instructionIndex: instruction.index, discriminator, accountCount };
  if (!quote.found || !asset.found) return { event: null, classification: classify(pool, signature, transaction, receivedAt, "TOKEN_BALANCE_MISSING", "TOKEN_BALANCE_MISSING", "目标 Pool 的两侧 Vault 缺少 pre/post Token Balance", extra) };
  if (quote.missingDecimals || asset.missingDecimals || quote.decimals === null || asset.decimals === null) return { event: null, classification: classify(pool, signature, transaction, receivedAt, "TOKEN_DECIMALS_MISSING", "TOKEN_DECIMALS_MISSING", "Token Balance 缺少 decimals，无法进行原子单位换算", extra) };
  const transferDeltas = context.transferDeltas ?? transferDeltaForPool(transaction, pool);
  const quoteTransfer = transferDeltas.get(pool.quoteMint);
  const assetTransfer = transferDeltas.get(pool.assetMint);
  const quoteDelta = context.transferDeltas?.has(pool.quoteMint) ? context.transferDeltas.get(pool.quoteMint) as bigint : quote.deltaAtomic;
  const assetDelta = context.transferDeltas?.has(pool.assetMint) ? context.transferDeltas.get(pool.assetMint) as bigint : asset.deltaAtomic;
  if (context.transferDeltas && (quoteTransfer === undefined || assetTransfer === undefined)) {
    return {
      event: null,
      classification: classify(pool, signature, transaction, receivedAt, "AMOUNT_RECONCILIATION_FAILED", "SWAP_SEGMENT_TRANSFER_MISSING", `Swap 指令段缺少两侧 Token transfer：quote=${quoteTransfer?.toString() ?? "null"} asset=${assetTransfer?.toString() ?? "null"}`, extra),
    };
  }
  if ((quoteTransfer !== undefined && quoteTransfer !== quoteDelta) || (assetTransfer !== undefined && assetTransfer !== assetDelta)) {
    return {
      event: null,
      classification: classify(pool, signature, transaction, receivedAt, "AMOUNT_RECONCILIATION_FAILED", "VAULT_TRANSFER_DELTA_MISMATCH", `Vault delta 与 Token transfer delta 不一致：quote=${quoteDelta.toString()}/${quoteTransfer?.toString() ?? "null"} asset=${assetDelta.toString()}/${assetTransfer?.toString() ?? "null"}`, extra),
    };
  }
  const quoteIn = quoteDelta > 0n && assetDelta < 0n;
  const assetIn = assetDelta > 0n && quoteDelta < 0n;
  if (!quoteIn && !assetIn) return { event: null, classification: classify(pool, signature, transaction, receivedAt, "AMOUNT_RECONCILIATION_FAILED", "VAULT_DIRECTION_INVALID", `Vault delta 方向无法形成 Swap：quote=${quoteDelta.toString()} asset=${assetDelta.toString()}`, extra) };
  const inputMint = quoteIn ? pool.quoteMint : pool.assetMint;
  const outputMint = quoteIn ? pool.assetMint : pool.quoteMint;
  const inputAtomic = quoteIn ? quoteDelta : assetDelta;
  const outputAtomic = quoteIn ? -assetDelta : -quoteDelta;
  const quoteUnits = atomicToUnits(quoteDelta < 0n ? -quoteDelta : quoteDelta, quote.decimals);
  const assetUnits = atomicToUnits(assetDelta < 0n ? -assetDelta : assetDelta, asset.decimals);
  const volume = quoteUnits !== null && quoteUnits > 0 ? quoteUnits : assetUnits !== null && assetUnits > 0 && pool.currentPrice !== null ? assetUnits * pool.currentPrice : null;
  if (volume === null || !Number.isFinite(volume) || volume <= 0) return { event: null, classification: classify(pool, signature, transaction, receivedAt, "AMOUNT_RECONCILIATION_FAILED", "VOLUME_NOT_DERIVABLE", "无法由 quote 或 asset Vault delta 推导 USD 成交额", extra) };
  const feeStatus: SwapErrorCategory = pool.hasDynamicFee ? "FEE_VERSION_UNSUPPORTED" : pool.feeRate === null ? "FEE_CONFIG_MISSING" : "PARSED_SWAP";
  const grossFeeAtomic = feeAtomic(inputAtomic, pool.feeRate);
  const inputUnits = atomicToUnits(inputAtomic, quoteIn ? quote.decimals : asset.decimals);
  const feeUsd = pool.feeRate === null || inputUnits === null ? null : inputUnits * (quoteIn ? 1 : pool.currentPrice ?? 0) * pool.feeRate;
  const event: RecentSwapEvent = {
    poolId: pool.id,
    signature,
    instructionIndex: instruction.index,
    trader: keys[0] ?? null,
    slot: transaction.slot as number,
    blockTime: new Date((transaction.blockTime as number) * 1000).toISOString(),
    receivedAt,
    volume,
    fee: feeUsd,
    parsedAt: new Date().toISOString(),
    persistedAt: null,
    parseLatencyMs: null,
    persistenceLatencyMs: null,
    source: "rpc-replay",
    programVersion: pool.programId,
    inputMint,
    outputMint,
    actualAmountInAtomic: inputAtomic.toString(),
    actualAmountOutAtomic: outputAtomic.toString(),
    baseFeeRate: pool.feeRate,
    dynamicFeeRate: pool.hasDynamicFee ? null : pool.feeRate,
    effectiveFeeRate: pool.feeRate,
    grossTradeFeeAtomic: grossFeeAtomic,
    protocolFeeAtomic: null,
    fundFeeAtomic: null,
    lpFeeAtomic: grossFeeAtomic,
    token2022TransferFeeAtomic: null,
    priceUsd: pool.currentPrice,
    feeUsd,
  };
  return {
    event,
    classification: classify(pool, signature, transaction, receivedAt, feeStatus, feeStatus, feeStatus === "PARSED_SWAP" ? "Swap 已按 Vault pre/post balance 解析" : "Swap 已解析，但 Fee 配置尚未支持逐笔确认", extra),
  };
}

export function parseClmmSwap(context: SwapParseContext): SwapParseOutput {
  return parseRaydiumSwap(context);
}

export function parseCpmmSwap(context: SwapParseContext): SwapParseOutput {
  return parseRaydiumSwap(context);
}

export function parseAmmV4Swap(context: SwapParseContext): SwapParseOutput {
  return parseRaydiumSwap(context);
}

export type ParsedProgramTransaction = {
  event: RecentSwapEvent | null;
  events: RecentSwapEvent[];
  matched: boolean;
  unknown: boolean;
  classifications: TransactionClassification[];
};

export function parseProgramTransaction(pool: ProgramBackfillPool, signature: string, transaction: HistoricalTransaction, receivedAt: string): ParsedProgramTransaction {
  const keys = transactionAccounts(transaction);
  const outer = transactionInstructions(transaction, keys);
  const inner = innerInstructions(transaction, keys);
  const allInstructions = [...outer, ...inner];
  const referenced = new Set([...keys, ...allInstructions.flatMap((item) => item.accounts), ...innerInstructionAccounts(transaction, keys)]);
  if (transaction.meta?.err) {
    const classification = classify(pool, signature, transaction, receivedAt, "ONCHAIN_TRANSACTION_FAILED", "ONCHAIN_TRANSACTION_FAILED", "交易 meta.err 非空，链上执行失败");
    return { event: null, events: [], matched: referenced.has(pool.id), unknown: false, classifications: [classification] };
  }
  if (!referenced.has(pool.id)) {
    const classification = classify(pool, signature, transaction, receivedAt, "NOT_TARGET_POOL", "NOT_TARGET_POOL", "完整静态账户、ALT账户与指令账户中不包含目标 Pool 地址");
    return { event: null, events: [], matched: false, unknown: false, classifications: [classification] };
  }
  if (typeof transaction.slot !== "number" || typeof transaction.blockTime !== "number") {
    const classification = classify(pool, signature, transaction, receivedAt, "PARSE_EXCEPTION", "TRANSACTION_METADATA_MISSING", "slot 或 blockTime 缺失");
    return { event: null, events: [], matched: true, unknown: true, classifications: [classification] };
  }
  const logs = transaction.meta?.logMessages ?? [];
  const supportedInstructions = allInstructions.filter((item) => item.programId && RAYDIUM_PROGRAM_IDS.has(item.programId));
  const targetProgramInstructions = supportedInstructions.filter((item) => item.programId === pool.programId);
  // 一个多跳交易可能包含多个 Raydium instruction；只有 instruction 自身
  // 的账户集合引用该目标 Pool 才能使用它，不能把同一笔交易的其它 hop
  // 的余额差重复记到当前 Pool。
  const poolInstructions = targetProgramInstructions.filter((item) => item.accounts.includes(pool.id));
  const resolvedPoolInstructions = poolInstructions.length > 0 ? poolInstructions : targetProgramInstructions;
  if (supportedInstructions.length === 0) {
    const hasSwapSignal = logs.some((log) => /instruction:\s*(swap|route)|raydium.*swap|swap.?event/i.test(log));
    const category: SwapErrorCategory = hasSwapSignal ? "PROGRAM_UNSUPPORTED" : "NOT_RAYDIUM_SWAP";
    const classification = classify(pool, signature, transaction, receivedAt, category, category, hasSwapSignal ? "交易包含 Swap 信号但没有受支持的 Raydium Program ID" : "目标 Pool 交易不是 Raydium Swap", { programId: null, accountCount: referenced.size });
    return { event: null, events: [], matched: true, unknown: category === "PROGRAM_UNSUPPORTED", classifications: [classification] };
  }
  if (targetProgramInstructions.length === 0) {
    const classification = classify(pool, signature, transaction, receivedAt, "NOT_RAYDIUM_SWAP", "POOL_PROGRAM_MISMATCH", "目标 Pool 被引用，但没有目标 Raydium Program 的 outer instruction", { programId: supportedInstructions[0]?.programId ?? null, accountCount: referenced.size });
    return { event: null, events: [], matched: true, unknown: false, classifications: [classification] };
  }
  const hasSwapSignal = logs.some((log) => /instruction:\s*(swap|route)|raydium.*swap|swap.?event/i.test(log));
  if (!hasSwapSignal) {
    const instruction = resolvedPoolInstructions[0];
    const nonSwapInstruction = logs.some((log) => /instruction:\s*(collect|increase|decrease|open|close|initialize|create|update|set|transfer)/i.test(log));
    const category: SwapErrorCategory = nonSwapInstruction ? "NOT_RAYDIUM_SWAP" : "INSTRUCTION_DISCRIMINATOR_UNKNOWN";
    const classification = classify(pool, signature, transaction, receivedAt, category, category, nonSwapInstruction ? "目标 Pool 交易是 Raydium 非 Swap 指令" : "目标 Raydium instruction 未出现已知 Swap 日志", { programId: instruction.programId, instructionIndex: instruction.index, discriminator: discriminatorFor(instruction, logs), accountCount: referenced.size });
    return { event: null, events: [], matched: true, unknown: category === "INSTRUCTION_DISCRIMINATOR_UNKNOWN", classifications: [classification] };
  }
  const swapInstructions = resolvedPoolInstructions.filter(isRaydiumSwapInstruction);
  const instructionsToParse = swapInstructions.length > 0 ? swapInstructions : resolvedPoolInstructions;
  const outputs = instructionsToParse.map((instruction) => {
    const discriminator = discriminatorFor(instruction, logs);
    const context: SwapParseContext = {
      pool,
      signature,
      transaction,
      receivedAt,
      keys,
      instruction,
      discriminator,
      accountCount: referenced.size,
      transferDeltas: isRaydiumSwapInstruction(instruction)
        ? transferDeltaForPoolInstruction(transaction, pool, instruction.index, keys)
        : undefined,
    };
    if (pool.poolKind === "CPMM") return parseCpmmSwap(context);
    if (pool.poolKind === "AMM v4") return parseAmmV4Swap(context);
    return parseClmmSwap(context);
  });
  const events = outputs.flatMap((item) => item.event ? [item.event] : []);
  const classifications = outputs.map((item) => item.classification);
  return { event: events[0] ?? null, events, matched: true, unknown: events.length === 0, classifications };
}

function coverageForProgramWindow(pool: ProgramBackfillPool, window: WindowKey, now: Date, sinceMs: number, signatures: SignatureInfo[], fetched: Map<string, { transaction: HistoricalTransaction | null; error: string | null }>, events: RecentSwapEvent[], matchedSignatures: Set<string>, unknownInstructions: Set<string>, scanComplete: boolean): EventWindowCoverage {
  const startMs = now.getTime() - BACKFILL_WINDOW_SECONDS[window] * 1000;
  const inRange = signatures.filter((item) => typeof item.blockTime === "number" && item.blockTime * 1000 >= startMs && item.blockTime * 1000 <= now.getTime());
  const matched = inRange.filter((item) => item.signature && matchedSignatures.has(item.signature));
  const transactions = matched.map((item) => fetched.get(item.signature as string)).filter((item): item is { transaction: HistoricalTransaction | null; error: string | null } => Boolean(item));
  const successful = transactions.filter((item) => item.transaction !== null && item.error === null).length;
  const failed = transactions.length - successful;
  const poolEvents = events.filter((event) => Date.parse(event.blockTime) >= startMs && Date.parse(event.blockTime) <= now.getTime() && event.poolId === pool.id);
  const unknown = [...unknownInstructions].filter((key) => inRange.some((item) => item.signature === key)).length;
  const complete = scanComplete && failed === 0 && unknown === 0;
  const first = [...poolEvents].sort((a, b) => a.slot - b.slot)[0] ?? null;
  const last = [...poolEvents].sort((a, b) => b.slot - a.slot)[0] ?? null;
  const slots = inRange.flatMap((item) => typeof item.slot === "number" ? [item.slot] : []).sort((a, b) => a - b);
  return {
    eventCount: poolEvents.length,
    poolCount: poolEvents.length > 0 ? 1 : 0,
    firstSlot: first?.slot ?? slots[0] ?? null,
    lastSlot: last?.slot ?? slots.at(-1) ?? null,
    firstEventAt: first?.blockTime ?? null,
    lastEventAt: last?.blockTime ?? null,
    completeness: complete ? 100 : matched.length > 0 ? (successful / matched.length) * 100 : null,
    persisted: false,
    source: `program-wide ${pool.programId} → batch getTransaction`,
    windowStart: new Date(startMs).toISOString(),
    windowEnd: now.toISOString(),
    startSlot: slots[0] ?? null,
    endSlot: slots.at(-1) ?? null,
    expectedSlotRange: slots.length > 0 ? { start: slots[0] as number, end: slots.at(-1) as number } : null,
    signaturesDiscovered: matched.length,
    transactionsFetched: transactions.length,
    transactionsSuccessful: successful,
    transactionsFailed: failed,
    swapsParsed: poolEvents.length,
    swapsRejected: Math.max(0, successful - poolEvents.length),
    duplicatesRemoved: 0,
    unknownInstructions: unknown,
    gapSlots: complete ? 0 : null,
    coverageRatio: complete ? 100 : matched.length > 0 ? (successful / matched.length) * 100 : scanComplete ? 100 : null,
    firstEventTime: first?.blockTime ?? null,
    lastEventTime: last?.blockTime ?? null,
    backfillStatus: complete ? "COMPLETE" : scanComplete ? "PARTIAL" : "BACKFILLING",
  };
}

export async function collectProgramWideRwaSwapEvents(provider: RpcProvider | null, pools: ProgramBackfillPool[], options: ProgramBackfillOptions = {}): Promise<ProgramBackfillResult> {
  const now = options.now ?? new Date();
  const targetWindow = options.targetWindow ?? "24h";
  const windowHours: Record<WindowKey, number> = { "1m": 1 / 60, "5m": 5 / 60, "30m": 0.5, "1h": 1, "6h": 6, "12h": 12, "24h": 24 };
  const hours = Math.max(1 / 60, options.hours ?? windowHours[targetWindow]);
  const sinceMs = now.getTime() - hours * 60 * 60 * 1000;
  const targetIds = options.targetPoolIds ? new Set(options.targetPoolIds) : null;
  const targetPools = targetIds ? pools.filter((pool) => targetIds.has(pool.id)) : pools;
  const empty: ProgramBackfillResult = {
    events: [],
    coverage: {},
    signaturesDiscovered: 0,
    transactionsFetched: 0,
    transactionsSuccessful: 0,
    transactionsFailed: 0,
    unknownInstructions: 0,
    complete: false,
    errors: provider ? [] : ["没有可用 RPC"],
    provider: provider?.url ?? null,
  };
  if (!provider || targetPools.length === 0) return empty;
  const pageLimit = Math.min(1000, Math.max(100, options.pageLimit ?? Number(process.env.LP_INDEXER_SIGNATURE_PAGE_LIMIT ?? 1000)));
  const configuredMaxPages = process.env.LP_INDEXER_MAX_PAGES;
  const configuredMaxTransactions = process.env.LP_INDEXER_MAX_TRANSACTIONS;
  const maxPages = options.maxPages ?? (configuredMaxPages ? Math.max(1, Number(configuredMaxPages)) : Number.POSITIVE_INFINITY);
  const maxTransactions = options.maxTransactions ?? (configuredMaxTransactions ? Math.max(100, Number(configuredMaxTransactions)) : Number.POSITIVE_INFINITY);
  const batchSize = Math.min(100, Math.max(1, options.batchSize ?? Number(process.env.LP_INDEXER_BATCH_SIZE ?? 25)));
  const poolTier = options.poolTier ?? 3;
  const signatures: SignatureInfo[] = [];
  const errors: string[] = [];
  let scanComplete = true;
  // 目标发现必须按 Pool 地址进行。按 Program ID 扫描会把该协议的所有
  // 交易混入候选，随后又被错误计为 parser failure。
  for (const pool of targetPools) {
    const poolAddress = pool.id;
    const programId = pool.programId;
    const checkpointKey = `rwa:${targetWindow}:tier${poolTier}:pool:${poolAddress}`;
    const checkpoint = readBackfillCheckpoint(checkpointKey);
    let before: string | undefined = checkpoint?.status === "COMPLETE" ? undefined : checkpoint?.beforeSignature ?? undefined;
    let page = checkpoint?.status === "COMPLETE" ? maxPages : checkpoint?.page ?? 0;
    const persistedSignatures = readBackfillSignatures(checkpointKey);
    signatures.push(...persistedSignatures.map((item) => ({ signature: item.signature, slot: item.slot ?? undefined, blockTime: item.blockTime, err: item.err ? {} : undefined })));
    let reachedWindow = false;
    if (checkpoint?.status === "COMPLETE") reachedWindow = true;
    for (; page < maxPages && !reachedWindow; page += 1) {
      const params: Record<string, unknown> = { limit: pageLimit, commitment: "confirmed" };
      if (before) params.before = before;
      const response = await rpcRequest<SignatureInfo[]>(provider, "getSignaturesForAddress", [poolAddress, params], 20_000);
      if (response.error) {
        errors.push(`${poolAddress} 签名扫描：${response.error}`);
        scanComplete = false;
        persistBackfillCheckpoint({ checkpointKey, windowKey: targetWindow, programId, beforeSignature: before ?? null, page, signaturesDiscovered: signatures.length, transactionsFetched: 0, status: "FAILED", poolTier, updatedAt: now.toISOString() });
        break;
      }
      const batch = response.result ?? [];
      signatures.push(...batch);
      persistBackfillSignatures(checkpointKey, batch.flatMap((item) => typeof item.signature === "string" ? [{ signature: item.signature, slot: typeof item.slot === "number" ? item.slot : null, blockTime: typeof item.blockTime === "number" ? item.blockTime : null, err: Boolean(item.err) }] : []));
      const oldest = batch.at(-1);
      if (batch.length === 0 || batch.length < pageLimit || (typeof oldest?.blockTime === "number" && oldest.blockTime * 1000 <= sinceMs)) {
        reachedWindow = true;
        persistBackfillCheckpoint({ checkpointKey, windowKey: targetWindow, programId, beforeSignature: null, page: page + 1, signaturesDiscovered: signatures.length, transactionsFetched: 0, status: "COMPLETE", poolTier, updatedAt: now.toISOString() });
        break;
      }
      before = oldest?.signature;
      if (!before) {
        reachedWindow = true;
        persistBackfillCheckpoint({ checkpointKey, windowKey: targetWindow, programId, beforeSignature: null, page: page + 1, signaturesDiscovered: signatures.length, transactionsFetched: 0, status: "COMPLETE", poolTier, updatedAt: now.toISOString() });
        break;
      }
      persistBackfillCheckpoint({ checkpointKey, windowKey: targetWindow, programId, beforeSignature: before, page: page + 1, signaturesDiscovered: signatures.length, transactionsFetched: 0, status: "RUNNING", poolTier, updatedAt: now.toISOString() });
    }
    if (!reachedWindow) scanComplete = false;
  }
  const uniqueSignatures = [...new Map(signatures.filter((item) => item.signature && !item.err && typeof item.blockTime === "number" && item.blockTime * 1000 >= sinceMs).map((item) => [item.signature as string, item])).values()]
    .sort((a, b) => (b.slot ?? 0) - (a.slot ?? 0))
    .slice(0, maxTransactions);
  if (uniqueSignatures.length >= maxTransactions) scanComplete = false;
  const fetched = new Map<string, { transaction: HistoricalTransaction | null; error: string | null }>();
  const cachedTransactions = readRpcTransactionCache(uniqueSignatures.map((item) => item.signature as string));
  for (const item of uniqueSignatures) {
    const cached = cachedTransactions.get(item.signature as string);
    if (!cached) continue;
    fetched.set(item.signature as string, { transaction: cached.status === "SUCCESS" && cached.payload ? cached.payload as HistoricalTransaction : null, error: cached.status === "FAILED" ? cached.error ?? "交易缓存标记失败" : null });
  }
  const missingSignatures = uniqueSignatures.filter((item) => !cachedTransactions.has(item.signature as string));
  for (let index = 0; index < missingSignatures.length; index += batchSize) {
    const chunk = missingSignatures.slice(index, index + batchSize);
    const results = await rpcBatchRequest<HistoricalTransaction>(provider, chunk.map((item, offset) => ({ id: index + offset + 1, method: "getTransaction", params: [item.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }] })));
    const cacheRows: CachedRpcTransaction[] = [];
    for (const [offset, item] of chunk.entries()) {
      const result = results[offset];
      const transaction = result?.result ?? null;
      const error = result?.error ?? (transaction ? null : "getTransaction 返回空");
      fetched.set(item.signature as string, { transaction, error });
      cacheRows.push({ signature: item.signature as string, slot: transaction?.slot ?? item.slot ?? null, blockTime: transaction?.blockTime ?? item.blockTime ?? null, payload: transaction, status: transaction ? "SUCCESS" : "FAILED", error, fetchedAt: now.toISOString(), providerUrl: provider.url });
    }
    persistRpcTransactionCache(cacheRows);
  }
  const matchedSignatures = new Map<string, Set<string>>();
  const unknownByPool = new Map<string, Set<string>>();
  const eventsByKey = new Map<string, RecentSwapEvent>();
  let successful = 0;
  let failed = 0;
  for (const item of uniqueSignatures) {
    const record = fetched.get(item.signature as string);
    if (!record || !record.transaction || record.error || record.transaction.meta?.err) {
      failed += 1;
      continue;
    }
    successful += 1;
    for (const pool of targetPools) {
      const parsed = parseProgramTransaction(pool, item.signature as string, record.transaction, now.toISOString());
      if (!parsed.matched) continue;
      const matched = matchedSignatures.get(pool.id) ?? new Set<string>();
      matched.add(item.signature as string);
      matchedSignatures.set(pool.id, matched);
      if (parsed.unknown) {
        const unknown = unknownByPool.get(pool.id) ?? new Set<string>();
        unknown.add(item.signature as string);
        unknownByPool.set(pool.id, unknown);
      }
      if (parsed.event) eventsByKey.set(`${parsed.event.signature}:${parsed.event.instructionIndex ?? 0}:${parsed.event.poolId}`, parsed.event);
    }
  }
  const events = [...eventsByKey.values()].sort((a, b) => b.slot - a.slot);
  const coverage: Record<string, Record<WindowKey, EventWindowCoverage>> = {};
  const targetWindowSeconds = BACKFILL_WINDOW_SECONDS[targetWindow];
  const reportWindows = WINDOW_KEYS.filter((window) => BACKFILL_WINDOW_SECONDS[window] <= targetWindowSeconds);
  for (const pool of targetPools) {
    const matched = matchedSignatures.get(pool.id) ?? new Set<string>();
    const unknown = unknownByPool.get(pool.id) ?? new Set<string>();
    coverage[pool.id] = Object.fromEntries(reportWindows.map((window) => [window, coverageForProgramWindow(pool, window, now, sinceMs, uniqueSignatures, fetched, events, matched, unknown, scanComplete)])) as Record<WindowKey, EventWindowCoverage>;
  }
  for (const pool of targetPools) {
    const checkpointKey = `rwa:${targetWindow}:tier${poolTier}:pool:${pool.id}`;
    const checkpoint = readBackfillCheckpoint(checkpointKey);
    if (checkpoint && checkpoint.status !== "COMPLETE") persistBackfillCheckpoint({ ...checkpoint, programId: pool.programId, signaturesDiscovered: uniqueSignatures.length, transactionsFetched: fetched.size, status: scanComplete ? "COMPLETE" : "RUNNING", updatedAt: now.toISOString() });
  }
  return {
    events,
    coverage,
    signaturesDiscovered: uniqueSignatures.length,
    transactionsFetched: fetched.size,
    transactionsSuccessful: successful,
    transactionsFailed: failed,
    unknownInstructions: [...unknownByPool.values()].reduce((total, set) => total + set.size, 0),
    complete: scanComplete && failed === 0 && [...unknownByPool.values()].every((set) => set.size === 0),
    errors,
    provider: provider.url,
  };
}

const BACKFILL_WINDOW_SECONDS: Record<WindowKey, number> = { "1m": 60, "5m": 5 * 60, "30m": 30 * 60, "1h": 60 * 60, "6h": 6 * 60 * 60, "12h": 12 * 60 * 60, "24h": 24 * 60 * 60 };

function emptyPoolWindowCoverage(window: WindowKey, now: Date): EventWindowCoverage {
  return {
    eventCount: 0,
    poolCount: 0,
    firstSlot: null,
    lastSlot: null,
    firstEventAt: null,
    lastEventAt: null,
    completeness: null,
    persisted: false,
    source: "Solana RPC getSignaturesForAddress + getTransaction",
    windowStart: new Date(now.getTime() - BACKFILL_WINDOW_SECONDS[window] * 1000).toISOString(),
    windowEnd: now.toISOString(),
    startSlot: null,
    endSlot: null,
    expectedSlotRange: null,
    signaturesDiscovered: 0,
    transactionsFetched: 0,
    transactionsSuccessful: 0,
    transactionsFailed: 0,
    swapsParsed: 0,
    swapsRejected: 0,
    duplicatesRemoved: 0,
    unknownInstructions: null,
    gapSlots: null,
    coverageRatio: null,
    firstEventTime: null,
    lastEventTime: null,
    backfillStatus: "PARTIAL",
  };
}

function eventFromTransaction(pool: SwapWindowPool, item: SignatureInfo, transaction: {
  slot?: number;
  blockTime?: number | null;
  transaction?: { message?: { accountKeys?: unknown[] } };
  meta?: { logMessages?: string[] | null; preTokenBalances?: TokenBalance[] | null; postTokenBalances?: TokenBalance[] | null };
}, parseLatencyMs: number): { event: RecentSwapEvent | null; unknown: boolean } {
  if (typeof transaction.slot !== "number" || typeof transaction.blockTime !== "number") return { event: null, unknown: true };
  const logs = transaction.meta?.logMessages ?? [];
  const isSwap = logs.some((log) => /instruction:\s*swap|raydiumclmmswap|swapevent/i.test(log));
  if (!isSwap) return { event: null, unknown: logs.some((log) => /instruction/i.test(log)) };
  const keys = (transaction.transaction?.message?.accountKeys ?? []).map(keyAtIndex);
  const pre = transaction.meta?.preTokenBalances ?? [];
  const post = transaction.meta?.postTokenBalances ?? [];
  const vaultIndexes = [pool.vaultA, pool.vaultB]
    .filter((address): address is string => Boolean(address))
    .map((address) => ({ index: keys.indexOf(address), address }))
    .filter((value) => value.index >= 0);
  if (vaultIndexes.length === 0) return { event: null, unknown: true };
  const quoteDelta = vaultIndexes.reduce((total, value) => total + balanceDelta(pre, post, value.index, pool.quoteMint), 0);
  const assetDelta = vaultIndexes.reduce((total, value) => total + balanceDelta(pre, post, value.index, pool.assetMint), 0);
  const quoteDeltaAtomic = vaultIndexes.reduce((total, value) => total + balanceDeltaAtomic(pre, post, value.index, pool.quoteMint), 0n);
  const assetDeltaAtomic = vaultIndexes.reduce((total, value) => total + balanceDeltaAtomic(pre, post, value.index, pool.assetMint), 0n);
  const volume = Math.abs(quoteDelta) > 0 ? Math.abs(quoteDelta) : Math.abs(assetDelta) * (pool.currentPrice ?? 0);
  if (!Number.isFinite(volume) || volume <= 0) return { event: null, unknown: true };
  const inputIsQuote = quoteDeltaAtomic > 0n;
  const inputAtomic = inputIsQuote ? quoteDeltaAtomic : assetDeltaAtomic;
  const outputAtomic = inputIsQuote ? assetDeltaAtomic : quoteDeltaAtomic;
  return {
    unknown: false,
    event: {
      poolId: pool.id,
      signature: item.signature as string,
      slot: transaction.slot,
      blockTime: new Date(transaction.blockTime * 1000).toISOString(),
      volume,
      fee: null,
      parsedAt: new Date().toISOString(),
      persistedAt: null,
      parseLatencyMs,
      persistenceLatencyMs: null,
      source: "rpc-replay",
      programVersion: pool.programVersion,
      inputMint: inputIsQuote ? pool.quoteMint : pool.assetMint,
      outputMint: inputIsQuote ? pool.assetMint : pool.quoteMint,
      actualAmountInAtomic: inputAtomic > 0n ? inputAtomic.toString() : null,
      actualAmountOutAtomic: outputAtomic < 0n ? (-outputAtomic).toString() : outputAtomic > 0n ? outputAtomic.toString() : null,
      baseFeeRate: pool.feeRate,
      dynamicFeeRate: null,
      effectiveFeeRate: null,
      grossTradeFeeAtomic: null,
      protocolFeeAtomic: null,
      fundFeeAtomic: null,
      lpFeeAtomic: null,
      token2022TransferFeeAtomic: null,
      priceUsd: pool.currentPrice,
      feeUsd: null,
    },
  };
}

function buildPoolWindowCoverage(now: Date, window: WindowKey, signatures: SignatureInfo[], transactions: Array<{ item: SignatureInfo; transaction: { slot?: number; blockTime?: number | null } | null; error: string | null }>, events: RecentSwapEvent[], pageComplete: boolean, unknownInstructions: number, duplicatesRemoved: number): EventWindowCoverage {
  const base = emptyPoolWindowCoverage(window, now);
  const startMs = now.getTime() - BACKFILL_WINDOW_SECONDS[window] * 1000;
  const eligible = signatures.filter((item) => typeof item.blockTime === "number" && item.blockTime * 1000 >= startMs && item.blockTime * 1000 <= now.getTime());
  const inTransactions = transactions.filter((item) => typeof item.item.blockTime === "number" && item.item.blockTime * 1000 >= startMs && item.item.blockTime * 1000 <= now.getTime());
  const inEvents = events.filter((event) => {
    const time = Date.parse(event.blockTime);
    return time >= startMs && time <= now.getTime();
  });
  const sortedSlots = eligible.flatMap((item) => typeof item.slot === "number" ? [item.slot] : []).sort((a, b) => a - b);
  const successful = inTransactions.filter((item) => item.transaction !== null && item.error === null).length;
  const failed = inTransactions.length - successful;
  const first = [...inEvents].sort((a, b) => a.slot - b.slot)[0] ?? null;
  const last = [...inEvents].sort((a, b) => b.slot - a.slot)[0] ?? null;
  const gapSlots = pageComplete ? 0 : null;
  const complete = pageComplete && failed === 0 && unknownInstructions === 0 && gapSlots === 0;
  return {
    ...base,
    eventCount: inEvents.length,
    poolCount: inEvents.length > 0 ? 1 : 0,
    firstSlot: sortedSlots[0] ?? null,
    lastSlot: sortedSlots.at(-1) ?? null,
    firstEventAt: first?.blockTime ?? null,
    lastEventAt: last?.blockTime ?? null,
    startSlot: sortedSlots[0] ?? null,
    endSlot: sortedSlots.at(-1) ?? null,
    expectedSlotRange: sortedSlots.length > 0 ? { start: sortedSlots[0], end: sortedSlots.at(-1) as number } : null,
    signaturesDiscovered: eligible.length,
    transactionsFetched: inTransactions.length,
    transactionsSuccessful: successful,
    transactionsFailed: failed,
    swapsParsed: inEvents.length,
    swapsRejected: Math.max(0, successful - inEvents.length),
    duplicatesRemoved,
    unknownInstructions,
    gapSlots,
    coverageRatio: complete ? 100 : null,
    firstEventTime: first?.blockTime ?? null,
    lastEventTime: last?.blockTime ?? null,
    backfillStatus: complete ? "COMPLETE" : "PARTIAL",
  };
}

export async function collectRecentPoolSwapEventsDetailed(provider: RpcProvider | null, pools: SwapWindowPool[], now = new Date()): Promise<SwapCollectionResult> {
  const coverage: Record<string, Record<WindowKey, EventWindowCoverage>> = {};
  if (!provider || pools.length === 0) return { events: [], coverage, completePoolIds: [], errors: provider ? [] : ["没有可用 RPC"] };
  const pageLimit = Math.max(50, Number(process.env.LP_BACKFILL_SIGNATURE_PAGE_LIMIT ?? 500));
  const maxPages = Math.max(1, Number(process.env.LP_BACKFILL_MAX_PAGES ?? 8));
  const maxTransactions = Math.max(50, Number(process.env.LP_BACKFILL_MAX_TRANSACTIONS_PER_POOL ?? 200));
  const sinceMs = now.getTime() - BACKFILL_WINDOW_SECONDS["24h"] * 1000;
  const errors: string[] = [];
  const results = await mapWithConcurrency(pools, 2, async (pool) => {
    const signatures: SignatureInfo[] = [];
    let before: string | undefined;
    let pageComplete = false;
    let error: string | null = null;
    for (let page = 0; page < maxPages; page += 1) {
      const params: Record<string, unknown> = { limit: pageLimit, commitment: "confirmed" };
      if (before) params.before = before;
      const response = await rpcRequest<SignatureInfo[]>(provider, "getSignaturesForAddress", [pool.id, params]);
      if (response.error) { error = response.error; break; }
      const batch = response.result ?? [];
      signatures.push(...batch);
      const oldest = batch.at(-1);
      if (batch.length === 0 || batch.length < pageLimit || (typeof oldest?.blockTime === "number" && oldest.blockTime * 1000 <= sinceMs)) {
        pageComplete = true;
        break;
      }
      before = oldest?.signature;
      if (!before) break;
    }
    const eligible = signatures.filter((item) => typeof item.signature === "string" && typeof item.blockTime === "number" && item.blockTime * 1000 >= sinceMs && !item.err);
    const candidates = eligible.slice(0, maxTransactions);
    const transactions = await mapWithConcurrency(candidates, 6, async (item) => {
      const startedAt = Date.now();
      const response = await rpcRequest<{ slot?: number; blockTime?: number | null; transaction?: { message?: { accountKeys?: unknown[] } }; meta?: { logMessages?: string[] | null; preTokenBalances?: TokenBalance[] | null; postTokenBalances?: TokenBalance[] | null } }>(provider, "getTransaction", [item.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
      return { item, transaction: response.result, error: response.error, parseLatencyMs: Date.now() - startedAt };
    });
    const events: RecentSwapEvent[] = [];
    let unknownInstructions = 0;
    for (const result of transactions) {
      if (!result.transaction) continue;
      const parsed = eventFromTransaction(pool, result.item, result.transaction, result.parseLatencyMs);
      if (parsed.unknown) unknownInstructions += 1;
      if (parsed.event) events.push(parsed.event);
    }
    const unique = new Map<string, RecentSwapEvent>();
    for (const event of events) unique.set(event.signature, event);
    const deduped = [...unique.values()];
    const reachedAllTransactions = candidates.length === eligible.length;
    const complete = pageComplete && reachedAllTransactions && !error;
    const poolCoverage = Object.fromEntries(WINDOW_KEYS.map((window) => [window, buildPoolWindowCoverage(now, window, signatures, transactions.map((item) => ({ item: item.item, transaction: item.transaction, error: item.error })), deduped, complete, unknownInstructions, events.length - deduped.length)])) as Record<WindowKey, EventWindowCoverage>;
    return { poolId: pool.id, events: deduped, coverage: poolCoverage, completePool: complete && Object.values(poolCoverage).every((item) => item.backfillStatus === "COMPLETE"), error };
  });
  const allEvents: RecentSwapEvent[] = [];
  const completePoolIds: string[] = [];
  for (const result of results) {
    coverage[result.poolId] = result.coverage;
    allEvents.push(...result.events);
    if (result.completePool) completePoolIds.push(result.poolId);
    if (result.error) errors.push(`${result.poolId}: ${result.error}`);
  }
  return { events: [...new Map(allEvents.map((event) => [event.signature, event])).values()].sort((a, b) => b.slot - a.slot), coverage, completePoolIds, errors };
}

async function probeWebSocketEndpoint(wsUrl: string, timeoutMs = 2_500): Promise<ServiceHealth> {
  const now = checkedAt();
  if (typeof WebSocket === "undefined") {
    return { name: "solana-ws", label: "Solana WebSocket", status: "离线", latencyMs: null, detail: "运行时不支持 WebSocket", sourceUrl: wsUrl, checkedAt: now };
  }
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let swapLogCount = 0;
    const expectedAcknowledgements = 1 + RAYDIUM_PROGRAM_IDS.size;
    const acknowledgements = new Set<number>();
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (error) {
      resolve({ name: "solana-ws", label: "Solana WebSocket", status: "离线", latencyMs: null, detail: error instanceof Error ? error.message : "连接失败", sourceUrl: wsUrl, checkedAt: now });
      return;
    }
    const finish = (health: ServiceHealth) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {
        // 连接已关闭。
      }
      resolve(health);
    };
    const timeout = setTimeout(() => finish({
      name: "solana-ws",
      label: "Solana WebSocket",
      status: "离线",
      latencyMs: Date.now() - startedAt,
      detail: "握手超时",
      sourceUrl: wsUrl,
      checkedAt: checkedAt(),
    }), timeoutMs);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "slotSubscribe" }));
      [...RAYDIUM_PROGRAM_IDS].forEach((programId, index) => {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: index + 2, method: "logsSubscribe", params: [{ mentions: [programId] }, { commitment: "confirmed" }] }));
      });
    });
    ws.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : "";
      if (!text) return;
      try {
        const message = JSON.parse(text) as { id?: number; result?: unknown; params?: { result?: { value?: { logs?: string[] } } } };
        if (typeof message.id === "number" && message.result !== undefined) {
          acknowledgements.add(message.id);
          if (acknowledgements.size >= expectedAcknowledgements) {
            finish({
              name: "solana-ws",
              label: "Solana WebSocket",
              status: "在线",
              latencyMs: Date.now() - startedAt,
              detail: `slotSubscribe + ${RAYDIUM_PROGRAM_IDS.size} 个 Raydium logsSubscribe 已确认 · 已捕获 ${swapLogCount} 笔 Swap 日志`,
              sourceUrl: wsUrl,
              checkedAt: checkedAt(),
            });
          }
          return;
        }
        const logs = message.params?.result?.value?.logs ?? [];
        if (logs.some((log) => /instruction:\s*swap|raydiumclmmswap|swapevent/i.test(log))) swapLogCount += 1;
      } catch {
        // 单条 WebSocket 消息损坏不应让探针退出。
      }
    });
    ws.addEventListener("error", () => finish({
      name: "solana-ws",
      label: "Solana WebSocket",
      status: "离线",
      latencyMs: Date.now() - startedAt,
      detail: "连接错误",
      sourceUrl: wsUrl,
      checkedAt: checkedAt(),
    }));
  });
}

export async function probeSolanaWebSocket(): Promise<ServiceHealth> {
  const urls = [...new Set(getRpcProviders().map((provider) => provider.wsUrl).filter((url): url is string => Boolean(url)))];
  if (urls.length === 0) return { name: "solana-ws", label: "Solana WebSocket", status: "未配置", latencyMs: null, detail: "等待 SOLANA_WS_URLS 或 RPC Provider 配置", sourceUrl: SOLANA_WS_DEFAULT, checkedAt: checkedAt() };
  const results = await Promise.all(urls.map((url) => probeWebSocketEndpoint(url)));
  return results.find((result) => result.status === "在线") ?? results.sort((a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity))[0];
}
