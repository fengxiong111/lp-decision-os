import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { SwapErrorCategory, TransactionClassification } from "@/packages/models/src";
import { fetchPoolKeys } from "@/services/raydium/keys";
import { parseProgramTransaction, type HistoricalTransaction, type ProgramBackfillPool } from "@/services/rpc/pool";
import {
  clearTransactionClassifications,
  clearNormalizedSwaps,
  persistNormalizedSwaps,
  persistRawTransactions,
  persistTransactionClassifications,
  readRpcTransactionCache,
  type RawTransactionCacheEntry,
} from "@/services/storage/event-index";

const TARGETS = [
  {
    id: "FjuBy7jjf9DXj9d3R7cHpvcnoFW2iQxf7F7P3vqx4Jza",
    symbol: "SPCX",
    assetMint: "SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb",
    feeRate: 0.0025,
  },
  {
    id: "AHNN6JmvaGG6XUoSg7sEr38gRYDB2jTbUvqXVuqaRHpq",
    symbol: "SPCXx",
    assetMint: "Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8",
    feeRate: 0.008,
  },
] as const;

const CLMM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PARSER_VERSION = "raydium-swap-parser-v2";

function databasePath(): string {
  if (process.env.LP_EVENT_DB_PATH) return process.env.LP_EVENT_DB_PATH;
  const local = path.join(process.cwd(), ".local-data", "lp-events.sqlite");
  return existsSync(local) ? local : path.join(process.cwd(), "db", "lp-events.sqlite");
}

function fetchCategory(error: string | null): { category: SwapErrorCategory | null; retryable: boolean; code: string | null } {
  if (!error) return { category: null, retryable: false, code: null };
  const value = error.toLowerCase();
  if (value.includes("429")) return { category: "RPC_429", retryable: true, code: "HTTP_429" };
  if (value.includes("timeout") || value.includes("abort")) return { category: "RPC_TIMEOUT", retryable: true, code: "RPC_TIMEOUT" };
  if (value.includes("熔断") || value.includes("network") || value.includes("fetch") || value.includes("连接")) return { category: "RPC_NETWORK_ERROR", retryable: true, code: "RPC_NETWORK_ERROR" };
  if (value.includes("version")) return { category: "TRANSACTION_VERSION_UNSUPPORTED", retryable: false, code: "TRANSACTION_VERSION_UNSUPPORTED" };
  if (value.includes("lookup") || value.includes("address table")) return { category: "ADDRESS_LOOKUP_TABLE_FAILED", retryable: false, code: "ADDRESS_LOOKUP_TABLE_FAILED" };
  if (value.includes("返回空") || value.includes("not available") || value.includes("不存在")) return { category: "TRANSACTION_NOT_AVAILABLE", retryable: false, code: "TRANSACTION_NOT_AVAILABLE" };
  return { category: "RPC_NETWORK_ERROR", retryable: true, code: "RPC_REQUEST_FAILED" };
}

function rpcFailureClassification(signature: string, error: string, observedAt: string): TransactionClassification {
  const failure = fetchCategory(error);
  return {
    signature,
    slot: null,
    blockTime: null,
    poolAddress: null,
    programId: null,
    transactionVersion: null,
    errorCategory: failure.category ?? "PARSE_EXCEPTION",
    errorCode: failure.code ?? "RPC_REQUEST_FAILED",
    errorMessage: error,
    retryable: failure.retryable,
    attemptCount: 1,
    firstSeenAt: observedAt,
    lastAttemptAt: observedAt,
    rawTransactionPath: `sqlite://raw_transactions/${signature}`,
    parserVersion: PARSER_VERSION,
    instructionIndex: null,
    discriminator: null,
    accountCount: null,
  };
}

async function main(): Promise<void> {
  const sqliteLoader = (process as NodeJS.Process & { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  const sqlite = sqliteLoader?.("node:sqlite") as unknown as { DatabaseSync: new (file: string) => { prepare: (sql: string) => { all: () => Array<{ signature: string }> } } } | undefined;
  if (!sqlite?.DatabaseSync) throw new Error("node:sqlite 不可用");
  const db = new sqlite.DatabaseSync(databasePath());
  const signatures = db.prepare("SELECT signature FROM rpc_transaction_cache ORDER BY slot DESC").all().map((row) => row.signature);
  const cache = readRpcTransactionCache(signatures);
  const keyResult = await fetchPoolKeys(TARGETS.map((target) => target.id));
  const pools: ProgramBackfillPool[] = TARGETS.map((target) => ({
    id: target.id,
    programId: CLMM,
    poolKind: "CLMM",
    vaultA: keyResult.keys.get(target.id)?.vaultA ?? null,
    vaultB: keyResult.keys.get(target.id)?.vaultB ?? null,
    assetMint: target.assetMint,
    quoteMint: USDC,
    currentPrice: 1,
    feeRate: target.feeRate,
    hasDynamicFee: false,
  }));
  const observedAt = new Date().toISOString();
  clearTransactionClassifications(PARSER_VERSION);
  clearNormalizedSwaps(PARSER_VERSION, pools.map((pool) => pool.id));
  const raw: RawTransactionCacheEntry[] = [];
  const classifications: TransactionClassification[] = [];
  const events = [] as ReturnType<typeof parseProgramTransaction>["events"];
  for (const signature of signatures) {
    const cached = cache.get(signature);
    if (!cached) continue;
    const transaction = cached.status === "SUCCESS" && cached.payload ? cached.payload as HistoricalTransaction : null;
    const error = cached.error ?? (transaction ? null : "交易缓存标记失败");
    const json = transaction ? JSON.stringify(transaction) : null;
    const fetchFailure = fetchCategory(error);
    raw.push({
      signature,
      slot: transaction?.slot ?? cached.slot,
      blockTime: transaction?.blockTime ?? cached.blockTime,
      transactionJson: json,
      fetchStatus: transaction && !error ? "SUCCESS" : "FAILED",
      fetchedAt: cached.fetchedAt,
      rpcEndpoint: cached.providerUrl,
      sha256: json ? createHash("sha256").update(json).digest("hex") : null,
      errorCategory: fetchFailure.category,
      errorCode: fetchFailure.code,
      errorMessage: error,
      retryable: fetchFailure.retryable,
      attemptCount: 1,
      firstSeenAt: cached.fetchedAt,
      lastAttemptAt: cached.fetchedAt,
      parserVersion: PARSER_VERSION,
    });
    if (!transaction || error) {
      if (error) classifications.push(rpcFailureClassification(signature, error, cached.fetchedAt));
      continue;
    }
    for (const pool of pools) {
      const parsed = parseProgramTransaction(pool, signature, transaction, observedAt);
      classifications.push(...parsed.classifications);
      events.push(...parsed.events);
    }
  }
  persistRawTransactions(raw);
  persistTransactionClassifications(classifications);
  persistNormalizedSwaps(events, PARSER_VERSION);
  const counts = Object.fromEntries(classifications.reduce((map, item) => map.set(item.errorCategory, (map.get(item.errorCategory) ?? 0) + 1), new Map<string, number>()));
  console.log(JSON.stringify({
    cacheRows: signatures.length,
    rawRows: raw.length,
    classificationRows: classifications.length,
    parsedEvents: events.length,
    counts,
    pools: pools.map((pool) => ({ id: pool.id, vaultA: pool.vaultA, vaultB: pool.vaultB })),
    keyError: keyResult.error,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
