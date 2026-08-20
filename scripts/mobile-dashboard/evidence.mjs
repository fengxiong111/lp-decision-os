import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import {
  ClmmConfigLayout,
  LiquidityMathUtil,
  PoolInfoLayout,
  TickArrayLayout,
  TickArrayUtil,
  TickUtil,
  getPdaTickArrayAddress,
} from "@raydium-io/raydium-sdk-v2";
import { buildStrategyCandidates, snapRange } from "./optimizer.mjs";

const BACKOFF_MS = Object.freeze([2_000, 4_000, 8_000, 16_000, 32_000, 60_000]);
const FEE_DENOMINATOR = 1_000_000n;
const WINDOW_HOURS = Object.freeze([1, 6, 12, 24]);
const SWAP_EVENT_DISCRIMINATOR = createHash("sha256").update("event:SwapEvent").digest().subarray(0, 8);
const SWAP_PARSER_VERSION = "raydium-clmm-swap-event-v3";

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function publicKey(value) {
  if (value instanceof PublicKey) return value;
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
}

function publicKeyString(value) {
  return value instanceof PublicKey ? value.toBase58() : typeof value === "string" ? value : null;
}

function bnString(value) {
  return value && typeof value.toString === "function" ? value.toString(10) : null;
}

function safeNumberFromString(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) || Number.isFinite(number) ? number : null;
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function json(value) {
  return JSON.stringify(value, (_, item) => {
    if (typeof item === "bigint") return item.toString();
    if (item instanceof PublicKey) return item.toBase58();
    if (item && typeof item.toString === "function" && item.constructor?.name === "BN") return item.toString(10);
    return item;
  });
}

function parseRetryAfter(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

function normalizedFeeRate(value) {
  const number = finite(value);
  if (number === null || number < 0) return null;
  return number > 1 ? number / Number(FEE_DENOMINATOR) : number;
}

function readU64LE(buffer, offset) {
  return buffer.readBigUInt64LE(offset);
}

function readU128LE(buffer, offset) {
  let value = 0n;
  for (let index = 15; index >= 0; index -= 1) value = (value << 8n) + BigInt(buffer[offset + index]);
  return value;
}

export function decodeSwapEventLog(log) {
  const prefix = "Program data: ";
  if (typeof log !== "string" || !log.startsWith(prefix)) return null;
  let data;
  try {
    data = Buffer.from(log.slice(prefix.length), "base64");
  } catch {
    return null;
  }
  if (data.length !== 221 || !data.subarray(0, 8).equals(SWAP_EVENT_DISCRIMINATOR)) return null;
  let offset = 8;
  const readPubkey = () => {
    const value = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
    offset += 32;
    return value;
  };
  try {
    const poolState = readPubkey();
    const sender = readPubkey();
    const tokenAccount0 = readPubkey();
    const tokenAccount1 = readPubkey();
    const amount0 = readU64LE(data, offset); offset += 8;
    const transferFee0 = readU64LE(data, offset); offset += 8;
    const amount1 = readU64LE(data, offset); offset += 8;
    const transferFee1 = readU64LE(data, offset); offset += 8;
    const zeroForOne = data[offset]; offset += 1;
    const sqrtPriceX64 = readU128LE(data, offset); offset += 16;
    const liquidity = readU128LE(data, offset); offset += 16;
    const tick = data.readInt32LE(offset); offset += 4;
    const tradeFee0 = readU64LE(data, offset); offset += 8;
    const tradeFee1 = readU64LE(data, offset); offset += 8;
    if ((zeroForOne !== 0 && zeroForOne !== 1) || offset !== data.length) return null;
    return {
      poolState,
      sender,
      tokenAccount0,
      tokenAccount1,
      amount0Atomic: amount0.toString(),
      transferFee0Atomic: transferFee0.toString(),
      amount1Atomic: amount1.toString(),
      transferFee1Atomic: transferFee1.toString(),
      zeroForOne: zeroForOne === 1,
      sqrtPriceX64: sqrtPriceX64.toString(),
      liquidity: liquidity.toString(),
      tick,
      tradeFee0Atomic: tradeFee0.toString(),
      tradeFee1Atomic: tradeFee1.toString(),
      discriminator: SWAP_EVENT_DISCRIMINATOR.toString("hex"),
    };
  } catch {
    return null;
  }
}

function atomicToUi(value, decimals) {
  if (typeof value !== "bigint" || !Number.isInteger(decimals) || decimals < 0 || decimals > 30) return null;
  const number = Number(value) / (10 ** decimals);
  return Number.isFinite(number) ? number : null;
}

function splitOfficialFee(tradeFeeAtomic, configState) {
  const tradeFee = BigInt(tradeFeeAtomic);
  const protocolRate = BigInt(Math.max(0, Math.trunc(configState?.protocolFeeRateAtomic ?? configState?.protocolFeeRate ?? 0)));
  const fundRate = BigInt(Math.max(0, Math.trunc(configState?.fundFeeRateAtomic ?? configState?.fundFeeRate ?? 0)));
  const protocolFee = tradeFee * protocolRate / FEE_DENOMINATOR;
  const fundFee = tradeFee * fundRate / FEE_DENOMINATOR;
  const lpFee = tradeFee - protocolFee - fundFee;
  return {
    tradeFee,
    protocolFee,
    fundFee,
    lpFee: lpFee >= 0n ? lpFee : 0n,
  };
}

function emptyParserMetrics() {
  return {
    transactionsLoaded: 0,
    onchainSuccess: 0,
    containsTargetPool: 0,
    raydiumSwapCandidate: 0,
    parsedSwap: 0,
    unsupportedSwap: 0,
    amountReconciliationFailed: 0,
    swapPathIncomplete: 0,
    normalizedSwaps: 0,
    signatureErrorsSkipped: 0,
  };
}

function accountData(account) {
  if (!account || !Array.isArray(account.data) || account.data[1] !== "base64" || typeof account.data[0] !== "string") return null;
  return Buffer.from(account.data[0], "base64");
}

class EvidenceStore {
  constructor(directory) {
    this.directory = directory;
    this.db = null;
  }

  async open() {
    await mkdir(this.directory, { recursive: true });
    this.db = new DatabaseSync(join(this.directory, "evidence.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rpc_cache (
        cache_key TEXT PRIMARY KEY,
        method TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pool_evidence (
        pool_address TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        pool_address TEXT PRIMARY KEY,
        before_signature TEXT,
        newest_signature TEXT,
        oldest_block_time INTEGER,
        last_seen_slot INTEGER,
        signatures_discovered INTEGER NOT NULL DEFAULT 0,
        transactions_fetched INTEGER NOT NULL DEFAULT 0,
        transactions_successful INTEGER NOT NULL DEFAULT 0,
        transactions_failed INTEGER NOT NULL DEFAULT 0,
        unresolved_retryable_transactions INTEGER NOT NULL DEFAULT 0,
        gap_count INTEGER,
        swaps_parsed INTEGER NOT NULL DEFAULT 0,
        unknown_instructions INTEGER NOT NULL DEFAULT 0,
        parser_metrics_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS raw_transactions (
        signature TEXT PRIMARY KEY,
        pool_address TEXT,
        slot INTEGER,
        block_time INTEGER,
        payload_json TEXT,
        status TEXT NOT NULL,
        error TEXT,
        retryable INTEGER NOT NULL DEFAULT 0,
        attempt_count INTEGER NOT NULL DEFAULT 1,
        fetched_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS swap_events (
        event_key TEXT PRIMARY KEY,
        pool_address TEXT NOT NULL,
        slot INTEGER NOT NULL,
        block_time INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS swap_events_pool_time ON swap_events(pool_address, block_time);
      CREATE TABLE IF NOT EXISTS window_coverage (
        pool_address TEXT NOT NULL,
        window_hours INTEGER NOT NULL,
        window_start TEXT NOT NULL,
        window_end TEXT NOT NULL,
        expected_bucket_count INTEGER NOT NULL,
        metrics_bucket_count INTEGER NOT NULL,
        observed_event_bucket_count INTEGER NOT NULL,
        coverage_ratio REAL,
        gap_count INTEGER,
        unknown_instructions INTEGER,
        unresolved_retryable_transactions INTEGER,
        backfill_status TEXT NOT NULL,
        window_complete INTEGER NOT NULL,
        first_event_time TEXT,
        last_event_time TEXT,
        replay_coverage_seconds INTEGER,
        total_swaps INTEGER,
        valid_swaps INTEGER,
        invalid_swaps INTEGER,
        path_coverage REAL,
        fee_coverage REAL,
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(pool_address, window_hours)
      );
      CREATE TABLE IF NOT EXISTS minute_buckets (
        pool_address TEXT NOT NULL,
        window_hours INTEGER NOT NULL,
        bucket_start TEXT NOT NULL,
        volume_usd REAL NOT NULL,
        lp_fee_usd REAL NOT NULL,
        swap_count INTEGER NOT NULL,
        zero_filled INTEGER NOT NULL,
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(pool_address, window_hours, bucket_start)
      );
    `);
    try {
      this.db.exec("ALTER TABLE checkpoints ADD COLUMN unresolved_retryable_transactions INTEGER NOT NULL DEFAULT 0");
    } catch {
      // Existing evidence caches already contain this column.
    }
    try {
      this.db.exec("ALTER TABLE raw_transactions ADD COLUMN pool_address TEXT");
    } catch {
      // Existing evidence caches already contain this column.
    }
    try {
      this.db.exec("ALTER TABLE checkpoints ADD COLUMN parser_metrics_json TEXT NOT NULL DEFAULT '{}'");
    } catch {
      // Existing evidence caches already contain this column.
    }
    try {
      this.db.exec("ALTER TABLE checkpoints ADD COLUMN gap_count INTEGER");
    } catch {
      // Existing evidence caches already contain this column.
    }
    for (const column of [
      "replay_coverage_seconds INTEGER",
      "total_swaps INTEGER",
      "valid_swaps INTEGER",
      "invalid_swaps INTEGER",
      "path_coverage REAL",
      "fee_coverage REAL",
    ]) {
      try { this.db.exec(`ALTER TABLE window_coverage ADD COLUMN ${column}`); } catch {
        // Existing evidence caches already contain this column.
      }
    }
    try {
      this.db.prepare("DELETE FROM swap_events WHERE json_extract(payload_json, '$.parserVersion') IS NULL OR json_extract(payload_json, '$.parserVersion') <> ?").run(SWAP_PARSER_VERSION);
    } catch {
      this.db.prepare("DELETE FROM swap_events WHERE payload_json NOT LIKE ?").run(`%\"parserVersion\":\"${SWAP_PARSER_VERSION}\"%`);
    }
    return this;
  }

  readCache(cacheKey) {
    if (!this.db) return null;
    const row = this.db.prepare("SELECT payload_json, expires_at FROM rpc_cache WHERE cache_key = ?").get(cacheKey);
    if (!row || Number(row.expires_at) < Date.now()) return null;
    try {
      return JSON.parse(String(row.payload_json));
    } catch {
      return null;
    }
  }

  writeCache(cacheKey, method, payload, ttlMs) {
    if (!this.db) return;
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO rpc_cache(cache_key,method,payload_json,updated_at,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at,expires_at=excluded.expires_at`).run(cacheKey, method, json(payload), now, Date.now() + ttlMs);
  }

  readPoolEvidence(poolAddress) {
    if (!this.db) return null;
    const row = this.db.prepare("SELECT payload_json FROM pool_evidence WHERE pool_address = ?").get(poolAddress);
    if (!row) return null;
    try {
      return JSON.parse(String(row.payload_json));
    } catch {
      return null;
    }
  }

  writePoolEvidence(poolAddress, payload) {
    if (!this.db) return;
    this.db.prepare(`INSERT INTO pool_evidence(pool_address,payload_json,updated_at) VALUES(?,?,?) ON CONFLICT(pool_address) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at`).run(poolAddress, json(payload), new Date().toISOString());
  }

  readCheckpoint(poolAddress) {
    if (!this.db) return null;
    return this.db.prepare("SELECT * FROM checkpoints WHERE pool_address = ?").get(poolAddress) ?? null;
  }

  writeCheckpoint(poolAddress, checkpoint) {
    if (!this.db) return;
    this.db.prepare(`INSERT INTO checkpoints(pool_address,before_signature,newest_signature,oldest_block_time,last_seen_slot,signatures_discovered,transactions_fetched,transactions_successful,transactions_failed,unresolved_retryable_transactions,gap_count,swaps_parsed,unknown_instructions,parser_metrics_json,status,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(pool_address) DO UPDATE SET before_signature=excluded.before_signature,newest_signature=excluded.newest_signature,oldest_block_time=excluded.oldest_block_time,last_seen_slot=excluded.last_seen_slot,signatures_discovered=excluded.signatures_discovered,transactions_fetched=excluded.transactions_fetched,transactions_successful=excluded.transactions_successful,transactions_failed=excluded.transactions_failed,unresolved_retryable_transactions=excluded.unresolved_retryable_transactions,gap_count=excluded.gap_count,swaps_parsed=excluded.swaps_parsed,unknown_instructions=excluded.unknown_instructions,parser_metrics_json=excluded.parser_metrics_json,status=excluded.status,updated_at=excluded.updated_at`).run(
      poolAddress,
      checkpoint.beforeSignature ?? null,
      checkpoint.newestSignature ?? null,
      checkpoint.oldestBlockTime ?? null,
      checkpoint.lastSeenSlot ?? null,
      checkpoint.signaturesDiscovered ?? 0,
      checkpoint.transactionsFetched ?? 0,
      checkpoint.transactionsSuccessful ?? 0,
      checkpoint.transactionsFailed ?? 0,
      checkpoint.unresolvedRetryableTransactions ?? 0,
      checkpoint.gapCount ?? null,
      checkpoint.swapsParsed ?? 0,
      checkpoint.unknownInstructions ?? 0,
      json(checkpoint.parserMetrics ?? emptyParserMetrics()),
      checkpoint.status,
      new Date().toISOString(),
    );
  }

  readTransaction(signature) {
    if (!this.db) return null;
    const row = this.db.prepare("SELECT * FROM raw_transactions WHERE signature = ?").get(signature);
    if (!row) return null;
    let payload = null;
    if (typeof row.payload_json === "string") {
      try { payload = JSON.parse(row.payload_json); } catch { payload = null; }
    }
    return { ...row, payload };
  }

  writeTransaction(signature, transaction) {
    if (!this.db) return;
    this.db.prepare(`INSERT INTO raw_transactions(signature,pool_address,slot,block_time,payload_json,status,error,retryable,attempt_count,fetched_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(signature) DO UPDATE SET pool_address=excluded.pool_address,slot=excluded.slot,block_time=excluded.block_time,payload_json=excluded.payload_json,status=excluded.status,error=excluded.error,retryable=excluded.retryable,attempt_count=raw_transactions.attempt_count+1,fetched_at=excluded.fetched_at`).run(
      signature,
      transaction.poolAddress ?? null,
      transaction.slot ?? null,
      transaction.blockTime ?? null,
      transaction.payload === null ? null : json(transaction.payload),
      transaction.status,
      transaction.error ?? null,
      transaction.retryable ? 1 : 0,
      1,
      new Date().toISOString(),
    );
  }

  countRetryableTransactions(poolAddress, sinceBlockTime) {
    if (!this.db) return 0;
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM raw_transactions WHERE pool_address = ? AND retryable = 1 AND status = 'FAILED' AND (block_time IS NULL OR block_time >= ?)").get(poolAddress, sinceBlockTime);
    return Number(row?.count ?? 0);
  }

  writeSwap(event) {
    if (!this.db || !event?.eventKey) return false;
    const result = this.db.prepare("INSERT INTO swap_events(event_key,pool_address,slot,block_time,payload_json) VALUES(?,?,?,?,?) ON CONFLICT(event_key) DO UPDATE SET pool_address=excluded.pool_address,slot=excluded.slot,block_time=excluded.block_time,payload_json=excluded.payload_json").run(event.eventKey, event.poolAddress, event.slot, event.blockTime, json(event));
    return Number(result?.changes ?? 0) > 0;
  }

  countSwaps(poolAddress, sinceBlockTime = 0) {
    if (!this.db) return 0;
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM swap_events WHERE pool_address = ? AND block_time >= ?").get(poolAddress, sinceBlockTime);
    return Number(row?.count ?? 0);
  }

  writeWindowCoverage(poolAddress, windows) {
    if (!this.db) return;
    const coverage = this.db.prepare(`INSERT INTO window_coverage(pool_address,window_hours,window_start,window_end,expected_bucket_count,metrics_bucket_count,observed_event_bucket_count,coverage_ratio,gap_count,unknown_instructions,unresolved_retryable_transactions,backfill_status,window_complete,first_event_time,last_event_time,replay_coverage_seconds,total_swaps,valid_swaps,invalid_swaps,path_coverage,fee_coverage,source,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(pool_address,window_hours) DO UPDATE SET window_start=excluded.window_start,window_end=excluded.window_end,expected_bucket_count=excluded.expected_bucket_count,metrics_bucket_count=excluded.metrics_bucket_count,observed_event_bucket_count=excluded.observed_event_bucket_count,coverage_ratio=excluded.coverage_ratio,gap_count=excluded.gap_count,unknown_instructions=excluded.unknown_instructions,unresolved_retryable_transactions=excluded.unresolved_retryable_transactions,backfill_status=excluded.backfill_status,window_complete=excluded.window_complete,first_event_time=excluded.first_event_time,last_event_time=excluded.last_event_time,replay_coverage_seconds=excluded.replay_coverage_seconds,total_swaps=excluded.total_swaps,valid_swaps=excluded.valid_swaps,invalid_swaps=excluded.invalid_swaps,path_coverage=excluded.path_coverage,fee_coverage=excluded.fee_coverage,source=excluded.source,updated_at=excluded.updated_at`);
    const bucket = this.db.prepare(`INSERT INTO minute_buckets(pool_address,window_hours,bucket_start,volume_usd,lp_fee_usd,swap_count,zero_filled,source,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(pool_address,window_hours,bucket_start) DO UPDATE SET volume_usd=excluded.volume_usd,lp_fee_usd=excluded.lp_fee_usd,swap_count=excluded.swap_count,zero_filled=excluded.zero_filled,source=excluded.source,updated_at=excluded.updated_at`);
    const now = new Date().toISOString();
    for (const [hours, window] of Object.entries(windows ?? {})) {
      const hoursNumber = Number(hours);
      this.db.prepare("DELETE FROM minute_buckets WHERE pool_address = ? AND window_hours = ?").run(poolAddress, hoursNumber);
      coverage.run(
        poolAddress,
        hoursNumber,
        window.windowStart,
        window.windowEnd,
        window.expectedBucketCount,
        window.metricsBucketCount,
        window.observedEventBucketCount,
        window.coverageRatio,
        window.gapCount,
        window.unknownInstructions,
        window.unresolvedRetryableTransactions,
        window.backfillStatus,
        window.windowComplete ? 1 : 0,
        window.firstEventTime,
        window.lastEventTime,
        window.replayCoverageSeconds ?? null,
        window.totalSwaps ?? null,
        window.validSwaps ?? null,
        window.invalidSwaps ?? null,
        window.pathCoverage ?? null,
        window.feeCoverage ?? null,
        "SOLANA_RPC_TRANSACTIONS",
        now,
      );
      for (const minute of window.minuteBuckets ?? []) {
        bucket.run(poolAddress, hoursNumber, minute.windowStart, minute.volumeUsd, minute.lpFeeUsd, minute.swapCount, minute.zeroFilled ? 1 : 0, "SOLANA_RPC_TRANSACTIONS", now);
      }
    }
  }

  readSwaps(poolAddress, sinceBlockTime = 0) {
    if (!this.db) return [];
    return this.db.prepare("SELECT payload_json FROM swap_events WHERE pool_address = ? AND block_time >= ? ORDER BY block_time ASC, slot ASC").all(poolAddress, sinceBlockTime).flatMap((row) => {
      try { return [JSON.parse(String(row.payload_json))]; } catch { return []; }
    });
  }

  close() {
    this.db?.close();
    this.db = null;
  }
}

class RpcLimiter {
  constructor(config) {
    this.maxConcurrency = config.rpcMaxConcurrency;
    this.globalInterval = 1_000 / config.rpcGlobalRps;
    this.methodIntervals = new Map([
      ["getTransaction", 1_000 / config.rpcTransactionRps],
      ["getSignaturesForAddress", 1_000 / config.rpcSignaturesRps],
    ]);
    this.active = 0;
    this.lastGlobal = 0;
    this.lastMethod = new Map();
  }

  async acquire(method) {
    while (true) {
      const now = Date.now();
      const waitForConcurrency = this.active >= this.maxConcurrency ? 25 : 0;
      const waitForGlobal = Math.max(0, this.lastGlobal + this.globalInterval - now);
      const interval = this.methodIntervals.get(method) ?? 0;
      const waitForMethod = Math.max(0, (this.lastMethod.get(method) ?? 0) + interval - now);
      const waitMs = Math.max(waitForConcurrency, waitForGlobal, waitForMethod);
      if (waitMs <= 0) {
        this.active += 1;
        this.lastGlobal = Date.now();
        this.lastMethod.set(method, this.lastGlobal);
        return () => { this.active = Math.max(0, this.active - 1); };
      }
      await sleep(waitMs);
    }
  }
}

class RpcClient {
  constructor(urls, config, store) {
    this.urls = unique(urls);
    this.config = config;
    this.store = store;
    this.limiter = new RpcLimiter(config);
    this.endpointIndex = 0;
    this.metrics = { requests: 0, rateLimited: 0, failures: 0, methods: {}, latencyMs: [], endpoints: {} };
  }

  async request(method, params, options = {}) {
    const cacheKey = options.cacheKey ?? null;
    if (cacheKey) {
      const cached = this.store.readCache(cacheKey);
      if (cached !== null) return { result: cached, error: null, fromCache: true };
    }
    if (this.urls.length === 0) return { result: null, error: "没有可用 Solana RPC", fromCache: false };
    const release = await this.limiter.acquire(method);
    try {
      for (let attempt = 0; attempt < BACKOFF_MS.length; attempt += 1) {
        const endpoint = this.urls[this.endpointIndex % this.urls.length];
        this.endpointIndex += 1;
        const startedAt = Date.now();
        this.metrics.requests += 1;
        this.metrics.methods[method] = (this.metrics.methods[method] ?? 0) + 1;
        this.metrics.endpoints[endpoint] = (this.metrics.endpoints[endpoint] ?? 0) + 1;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 25_000);
        try {
          const response = await fetch(endpoint, {
            method: "POST",
            headers: { accept: "application/json", "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: `${Date.now()}-${attempt}`, method, params }),
            signal: controller.signal,
          });
          const latency = Date.now() - startedAt;
          this.metrics.latencyMs.push(latency);
          if (response.status === 429) {
            this.metrics.rateLimited += 1;
            const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
            const jitter = Math.floor(Math.random() * 250);
            await sleep(Math.max(BACKOFF_MS[attempt], retryAfter) + jitter);
            continue;
          }
          if (!response.ok) {
            this.metrics.failures += 1;
            if (response.status >= 500 && attempt < BACKOFF_MS.length - 1) {
              await sleep(BACKOFF_MS[attempt] + Math.floor(Math.random() * 250));
              continue;
            }
            return { result: null, error: `HTTP ${response.status}`, fromCache: false };
          }
          const payload = await response.json();
          if (payload?.error) {
            this.metrics.failures += 1;
            return { result: null, error: payload.error.message ?? "RPC error", fromCache: false };
          }
          const result = payload?.result ?? null;
          if (cacheKey) this.store.writeCache(cacheKey, method, result, options.cacheTtlMs ?? 15_000);
          return { result, error: null, fromCache: false };
        } catch (error) {
          this.metrics.failures += 1;
          if (attempt < BACKOFF_MS.length - 1) {
            await sleep(BACKOFF_MS[attempt] + Math.floor(Math.random() * 250));
            continue;
          }
          return { result: null, error: error instanceof Error ? error.message : "RPC network error", fromCache: false };
        } finally {
          clearTimeout(timeout);
        }
      }
      return { result: null, error: "RPC retry budget exhausted", fromCache: false };
    } finally {
      release();
    }
  }
}

function decodePoolState(account) {
  const data = accountData(account?.value);
  if (!data) return null;
  try {
    return PoolInfoLayout.decode(data);
  } catch {
    return null;
  }
}

function decodeConfig(account) {
  const data = accountData(account?.value);
  if (!data) return null;
  try {
    return ClmmConfigLayout.decode(data);
  } catch {
    return null;
  }
}

function decodeTickArray(account) {
  const data = accountData(account);
  if (!data) return null;
  try {
    return TickArrayLayout.decode(data);
  } catch {
    return null;
  }
}

function statePrice(state) {
  try {
    const raw = Number(TickUtil.sqrtPriceX64ToPrice(state.sqrtPriceX64, state.mintDecimalsA, state.mintDecimalsB).toString());
    if (!Number.isFinite(raw) || raw <= 0) return null;
    const mintA = publicKeyString(state.mintA);
    return mintA === state.__usdcMint ? 1 / raw : raw;
  } catch {
    return null;
  }
}

function stateToEvidence(pool, state, configState, slot) {
  const apiMintA = publicKey(pool.apiMintA);
  const apiMintB = publicKey(pool.apiMintB);
  const onchainMintA = publicKey(state.mintA);
  const onchainMintB = publicKey(state.mintB);
  const identityPass = Boolean(apiMintA && apiMintB && onchainMintA && onchainMintB && apiMintA.equals(onchainMintA) && apiMintB.equals(onchainMintB));
  const onchainFeeRate = normalizedFeeRate(configState?.tradeFeeRate);
  const apiFeeRate = normalizedFeeRate(pool.feeRate);
  const protocolFeeRate = normalizedFeeRate(configState?.protocolFeeRate);
  const fundFeeRate = normalizedFeeRate(configState?.fundFeeRate);
  const tickFromSqrt = (() => {
    try { return TickUtil.getTickAtSqrtPrice(state.sqrtPriceX64); } catch { return null; }
  })();
  const price = statePrice({ ...state, __usdcMint: pool.quoteMint });
  const priceStatePass = price !== null && tickFromSqrt !== null && Math.abs(tickFromSqrt - state.tickCurrent) <= 1;
  const decimalsPass = Number.isInteger(pool.apiDecimalsA)
    && Number.isInteger(pool.apiDecimalsB)
    && state.mintDecimalsA === pool.apiDecimalsA
    && state.mintDecimalsB === pool.apiDecimalsB;
  const configPass = configState !== null
    && configState.tickSpacing === state.tickSpacing
    && onchainFeeRate !== null
    && protocolFeeRate !== null
    && fundFeeRate !== null
    && (apiFeeRate === null || Math.abs(onchainFeeRate - apiFeeRate) < 1e-9)
    && pool.hasDynamicFee !== true;
  const blockers = [];
  if (!identityPass) blockers.push("POOL_IDENTITY_MISMATCH");
  if (!decimalsPass) blockers.push("TOKEN_DECIMALS_MISMATCH");
  if (!priceStatePass) blockers.push("PRICE_STATE_INVALID");
  if (!configPass) blockers.push("FEE_CONFIGURATION_MISMATCH");
  if (pool.hasDynamicFee === true) blockers.push("DYNAMIC_FEE_REPLAY_UNSUPPORTED");
  return {
    poolStatePass: identityPass && decimalsPass && priceStatePass && configPass,
    identityPass,
    decimalsPass,
    priceStatePass,
    configPass,
    blockers,
    slot,
    poolAddress: pool.poolAddress,
    poolId: pool.poolAddress,
    sqrtPriceX64: bnString(state.sqrtPriceX64),
    tickCurrent: state.tickCurrent,
    tickFromSqrt,
    liquidity: bnString(state.liquidity),
    liquidityNumber: safeNumberFromString(bnString(state.liquidity)),
    ammConfig: publicKeyString(state.configId),
    tickSpacing: state.tickSpacing,
    tokenMint0: publicKeyString(state.mintA),
    tokenMint1: publicKeyString(state.mintB),
    mintDecimals0: state.mintDecimalsA,
    mintDecimals1: state.mintDecimalsB,
    vault0: publicKeyString(state.vaultA),
    vault1: publicKeyString(state.vaultB),
    feeRate: onchainFeeRate,
    tradeFeeRateAtomic: safeNumberFromString(String(configState?.tradeFeeRate ?? "")),
    protocolFeeRateAtomic: safeNumberFromString(String(configState?.protocolFeeRate ?? "")),
    fundFeeRateAtomic: safeNumberFromString(String(configState?.fundFeeRate ?? "")),
    protocolFeeRate,
    fundFeeRate,
    feeGrowthGlobalX64A: bnString(state.feeGrowthGlobalX64A),
    feeGrowthGlobalX64B: bnString(state.feeGrowthGlobalX64B),
    currentPrice: price,
    tickArrayBitmap: Buffer.isBuffer(state.tickArrayBitmap) ? state.tickArrayBitmap.toString("base64") : null,
    dynamicFeeInfo: state.dynamicFeeInfo ? {
      filterPeriod: state.dynamicFeeInfo.filterPeriod,
      decayPeriod: state.dynamicFeeInfo.decayPeriod,
      reductionFactor: state.dynamicFeeInfo.reductionFactor,
      dynamicFeeControl: state.dynamicFeeInfo.dynamicFeeControl,
      maxVolatilityAccumulator: state.dynamicFeeInfo.maxVolatilityAccumulator,
      volatilityReference: state.dynamicFeeInfo.volatilityReference,
      volatilityAccumulator: state.dynamicFeeInfo.volatilityAccumulator,
      lastUpdateTimestamp: bnString(state.dynamicFeeInfo.lastUpdateTimestamp),
    } : null,
  };
}

async function readPoolState(client, pool, options = {}) {
  const poolAddress = publicKey(pool.poolAddress);
  if (!poolAddress) return { poolState: null, error: "POOL_ADDRESS_INVALID" };
  const cacheTtlMs = options.forceRefresh === true ? 0 : 15_000;
  const accountResponse = await client.request("getAccountInfo", [poolAddress.toBase58(), { encoding: "base64", commitment: "confirmed" }], { cacheKey: `pool-state:${pool.poolAddress}`, cacheTtlMs });
  if (accountResponse.error || !accountResponse.result?.value) return { poolState: null, error: accountResponse.error ?? "POOL_STATE_NOT_FOUND" };
  const state = decodePoolState(accountResponse.result);
  if (!state) return { poolState: null, error: "POOL_STATE_DECODE_FAILED" };
  const owner = accountResponse.result.value.owner;
  if (owner !== pool.programId) return { poolState: null, error: "POOL_STATE_OWNER_MISMATCH" };
  const configAddress = publicKeyString(state.configId);
  const configResponse = configAddress
    ? await client.request("getAccountInfo", [configAddress, { encoding: "base64", commitment: "confirmed" }], { cacheKey: `amm-config:${configAddress}`, cacheTtlMs: options.forceRefresh === true ? 0 : 60 * 60_000 })
    : { result: null, error: "AMM_CONFIG_MISSING" };
  const configState = configResponse.result?.value ? decodeConfig(configResponse.result) : null;
  const evidence = stateToEvidence(pool, state, configState, accountResponse.result?.context?.slot ?? null);
  return { poolState: evidence, error: evidence.poolStatePass ? null : evidence.blockers[0] ?? "POOL_STATE_INVALID" };
}

function enumerateTickStarts(currentTick, tickSpacing, width = 0.1) {
  const lower = Math.floor(currentTick + Math.log(1 - width) / Math.log(1.0001));
  const upper = Math.ceil(currentTick + Math.log(1 + width) / Math.log(1.0001));
  const step = 60 * tickSpacing;
  const first = TickArrayUtil.getTickArrayStartIndex(lower, tickSpacing);
  const last = TickArrayUtil.getTickArrayStartIndex(upper, tickSpacing);
  const starts = [];
  for (let start = first; start <= last; start += step) starts.push(start);
  return { starts, lower, upper };
}

function compactTick(tick) {
  return {
    tick: tick.tick,
    liquidityNet: bnString(tick.liquidityNet),
    liquidityGross: bnString(tick.liquidityGross),
    feeGrowthOutsideX64A: bnString(tick.feeGrowthOutsideX64A),
    feeGrowthOutsideX64B: bnString(tick.feeGrowthOutsideX64B),
  };
}

function liquidityAtTick(currentTick, currentLiquidity, targetTick, ticks) {
  let liquidity = BigInt(currentLiquidity);
  const sorted = [...ticks].sort((a, b) => a.tick - b.tick);
  if (targetTick >= currentTick) {
    for (const tick of sorted) {
      if (tick.tick <= currentTick || tick.tick > targetTick) continue;
      liquidity += BigInt(tick.liquidityNet);
    }
  } else {
    for (const tick of sorted) {
      if (tick.tick <= targetTick || tick.tick > currentTick) continue;
      liquidity -= BigInt(tick.liquidityNet);
    }
  }
  return liquidity > 0n ? liquidity : 0n;
}

function rangeLiquidity(range, poolState, initializedTicks) {
  if (!range || poolState?.liquidity === null) return null;
  const lower = range.tickLower;
  const upper = range.tickUpper;
  const points = [lower, poolState.tickCurrent, upper, ...initializedTicks.map((tick) => tick.tick).filter((tick) => tick >= lower && tick <= upper)];
  const levels = unique(points.map(String)).map(Number).map((tick) => liquidityAtTick(poolState.tickCurrent, poolState.liquidity, tick, initializedTicks));
  if (levels.length === 0) return null;
  const min = levels.reduce((a, b) => a < b ? a : b);
  const max = levels.reduce((a, b) => a > b ? a : b);
  const average = levels.reduce((sum, item) => sum + item, 0n) / BigInt(levels.length);
  return {
    lowerTick: lower,
    upperTick: upper,
    min: min.toString(),
    max: max.toString(),
    average: average.toString(),
    minNumber: safeNumberFromString(min.toString()),
    averageNumber: safeNumberFromString(average.toString()),
    initializedTickCount: initializedTicks.filter((tick) => tick.tick >= lower && tick.tick <= upper).length,
  };
}

async function readTickArrays(client, pool, poolState) {
  const programId = publicKey(pool.programId);
  const poolId = publicKey(pool.poolAddress);
  if (!programId || !poolId || !Number.isInteger(poolState?.tickSpacing)) return { tickArrays: null, error: "TICK_ARRAY_INPUT_INVALID" };
  const coverage = enumerateTickStarts(poolState.tickCurrent, poolState.tickSpacing, 0.1);
  const addresses = coverage.starts.map((startIndex) => ({ startIndex, address: getPdaTickArrayAddress(programId, poolId, startIndex).publicKey.toBase58() }));
  const response = await client.request("getMultipleAccounts", [addresses.map((item) => item.address), { encoding: "base64", commitment: "confirmed" }], { cacheKey: `tick-arrays:${pool.poolAddress}:${coverage.starts.join(",")}`, cacheTtlMs: 15_000 });
  if (response.error || !Array.isArray(response.result?.value)) return { tickArrays: null, error: response.error ?? "TICK_ARRAY_RPC_FAILED" };
  const arrays = addresses.map((item, index) => {
    const account = response.result.value[index];
    const decoded = decodeTickArray(account);
    if (!decoded) return { address: item.address, startTickIndex: item.startIndex, exists: false, initializedTickCount: 0, ticks: [] };
    const poolMatch = publicKeyString(decoded.poolId) === pool.poolAddress;
    const ticks = decoded.ticks.filter((tick) => {
      try { return TickUtil.isInitialized({ data: tick }); } catch { return false; }
    }).map(compactTick);
    return {
      address: item.address,
      startTickIndex: decoded.startTickIndex,
      exists: poolMatch,
      initializedTickCount: decoded.initializedTickCount,
      ticks,
      poolMatch,
    };
  });
  const initializedTicks = arrays.flatMap((array) => array.ticks);
  const currentStart = TickArrayUtil.getTickArrayStartIndex(poolState.tickCurrent, poolState.tickSpacing);
  const currentArray = arrays.find((array) => array.startTickIndex === currentStart);
  const allDecodedOrEmpty = arrays.every((array) => array.exists || array.initializedTickCount === 0);
  const tickArrayPass = Boolean(currentArray?.exists && allDecodedOrEmpty);
  const ranges = {};
  for (const candidate of buildStrategyCandidates({
    coreWidths: [0.0025, 0.005, 0.0075, 0.01, 0.015, 0.02],
    bufferWidths: [0.02, 0.03, 0.05, 0.075, 0.1],
    allocations: [{ core: 0.8, buffer: 0.2 }, { core: 0.7, buffer: 0.3 }, { core: 0.6, buffer: 0.4 }],
    capital: 1_000,
  })) {
    const core = snapRange({ width: candidate.coreWidth }, { currentTick: poolState.tickCurrent, tickSpacing: poolState.tickSpacing, currentPrice: poolState.currentPrice, tickDirection: poolState.tickDirection ?? 1 });
    const buffer = snapRange({ width: candidate.bufferWidth }, { currentTick: poolState.tickCurrent, tickSpacing: poolState.tickSpacing, currentPrice: poolState.currentPrice, tickDirection: poolState.tickDirection ?? 1 });
    if (core && buffer) ranges[candidate.id] = { core: rangeLiquidity(core, poolState, initializedTicks), buffer: rangeLiquidity(buffer, poolState, initializedTicks) };
  }
  return {
    tickArrays: {
      tickArrayPass,
      coverage,
      arrays,
      initializedTicks,
      rangeLiquidity: ranges,
      slot: response.result?.context?.slot ?? null,
    },
    error: tickArrayPass ? null : "TICK_ARRAY_DATA_INCOMPLETE",
  };
}

function accountKey(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.pubkey === "string") return value.pubkey;
  return null;
}

function transactionKeys(transaction) {
  const staticKeys = transaction?.transaction?.message?.accountKeys ?? [];
  const loaded = transaction?.meta?.loadedAddresses ?? {};
  return [
    ...staticKeys.map(accountKey),
    ...(loaded.writable ?? []),
    ...(loaded.readonly ?? []),
  ].filter(Boolean);
}

function instructionLocationsForPool(transaction, pool) {
  const keys = transactionKeys(transaction);
  const instructions = transaction?.transaction?.message?.instructions ?? [];
  const locations = instructions.flatMap((instruction, index) => {
    const program = typeof instruction?.programId === "string"
      ? instruction.programId
      : typeof instruction?.programIdIndex === "number" ? keys[instruction.programIdIndex] : null;
    const accounts = Array.isArray(instruction?.accounts)
      ? instruction.accounts.map((item) => typeof item === "number" ? keys[item] : accountKey(item)).filter(Boolean)
      : [];
    return program === pool.programId && accounts.includes(pool.poolAddress) ? [{ instructionIndex: index, innerInstructionIndex: null }] : [];
  });
  for (const inner of transaction?.meta?.innerInstructions ?? []) {
    for (const [innerInstructionIndex, instruction] of (inner.instructions ?? []).entries()) {
      const program = typeof instruction?.programId === "string"
        ? instruction.programId
        : typeof instruction?.programIdIndex === "number" ? keys[instruction.programIdIndex] : null;
      const accounts = Array.isArray(instruction?.accounts)
        ? instruction.accounts.map((item) => typeof item === "number" ? keys[item] : accountKey(item)).filter(Boolean)
        : [];
      if (program === pool.programId && accounts.includes(pool.poolAddress)) locations.push({ instructionIndex: inner.index, innerInstructionIndex });
    }
  }
  return [...new Map(locations.map((location) => [`${location.instructionIndex}:${location.innerInstructionIndex ?? "outer"}`, location])).values()];
}

function balanceDelta(pre, post, index, mint) {
  const before = pre.find((item) => item.accountIndex === index && item.mint === mint);
  const after = post.find((item) => item.accountIndex === index && item.mint === mint);
  const beforeAmount = before?.uiTokenAmount?.amount;
  const afterAmount = after?.uiTokenAmount?.amount;
  if (typeof beforeAmount !== "string" && typeof afterAmount !== "string") return null;
  try { return BigInt(afterAmount ?? "0") - BigInt(beforeAmount ?? "0"); } catch { return null; }
}

function aggregateVaultDelta(transaction, poolState, mint) {
  const keys = transactionKeys(transaction);
  const pre = transaction?.meta?.preTokenBalances ?? [];
  const post = transaction?.meta?.postTokenBalances ?? [];
  const vaults = [poolState.tokenMint0 === mint ? poolState.vault0 : null, poolState.tokenMint1 === mint ? poolState.vault1 : null].filter(Boolean);
  let delta = 0n;
  let found = false;
  for (const vault of vaults) {
    const index = keys.indexOf(vault);
    if (index < 0) continue;
    const item = balanceDelta(pre, post, index, mint);
    if (item === null) continue;
    delta += item;
    found = true;
  }
  return found ? delta : null;
}

function parseSwapTransaction(transaction, pool, poolState, configState, signature) {
  if (!transaction || transaction.meta?.err) return { events: [], reason: "TRANSACTION_FAILED", metrics: emptyParserMetrics() };
  const instructionLocations = instructionLocationsForPool(transaction, pool);
  const logs = transaction.meta?.logMessages ?? [];
  const swapLog = logs.some((log) => /instruction:\s*swap|raydium.*swap|swap.?event/i.test(log));
  const decodedEvents = logs.map(decodeSwapEventLog).filter((event) => event?.poolState === pool.poolAddress);
  const containsTargetPool = instructionLocations.length > 0 || decodedEvents.length > 0;
  if (!containsTargetPool || !swapLog) {
    return { events: [], reason: "NOT_TARGET_RAYDIUM_SWAP", metrics: { ...emptyParserMetrics(), containsTargetPool: containsTargetPool ? 1 : 0 } };
  }
  const blockTime = typeof transaction.blockTime === "number" ? transaction.blockTime : null;
  const slot = typeof transaction.slot === "number" ? transaction.slot : null;
  if (blockTime === null || slot === null) return { events: [], reason: "TRANSACTION_TIME_UNAVAILABLE", metrics: { ...emptyParserMetrics(), containsTargetPool: 1, raydiumSwapCandidate: Math.max(decodedEvents.length, instructionLocations.length) } };
  const candidateCount = Math.max(decodedEvents.length, instructionLocations.length);
  if (decodedEvents.length === 0) {
    return {
      events: [],
      reason: "SWAP_PATH_INCOMPLETE",
      metrics: { ...emptyParserMetrics(), containsTargetPool: 1, raydiumSwapCandidate: candidateCount, unsupportedSwap: candidateCount, swapPathIncomplete: 1 },
    };
  }
  const delta0 = aggregateVaultDelta(transaction, poolState, poolState.tokenMint0);
  const delta1 = aggregateVaultDelta(transaction, poolState, poolState.tokenMint1);
  const eventDelta0 = decodedEvents.reduce((sum, event) => sum + (event.zeroForOne ? BigInt(event.amount0Atomic) : -BigInt(event.amount0Atomic)), 0n);
  const eventDelta1 = decodedEvents.reduce((sum, event) => sum + (event.zeroForOne ? -BigInt(event.amount1Atomic) : BigInt(event.amount1Atomic)), 0n);
  const transferAllowance0 = decodedEvents.reduce((sum, event) => sum + BigInt(event.transferFee0Atomic), 0n);
  const transferAllowance1 = decodedEvents.reduce((sum, event) => sum + BigInt(event.transferFee1Atomic), 0n);
  let reconciliationStatus = "UNAVAILABLE";
  let difference0 = null;
  let difference1 = null;
  if (delta0 !== null && delta1 !== null) {
    difference0 = delta0 - eventDelta0;
    difference1 = delta1 - eventDelta1;
    const pass0 = difference0 === 0n || difference0 === transferAllowance0 || difference0 === -transferAllowance0;
    const pass1 = difference1 === 0n || difference1 === transferAllowance1 || difference1 === -transferAllowance1;
    reconciliationStatus = pass0 && pass1 ? (difference0 === 0n && difference1 === 0n ? "PASS" : "PASS_WITH_TRANSFER_FEE") : "FAIL";
  }
  const parsedEvents = [];
  for (const [eventIndex, decoded] of decodedEvents.entries()) {
    const amount0 = BigInt(decoded.amount0Atomic);
    const amount1 = BigInt(decoded.amount1Atomic);
    const inputIsA = decoded.zeroForOne;
    const amountInAtomic = inputIsA ? amount0 : amount1;
    const amountOutAtomic = inputIsA ? amount1 : amount0;
    const inputMint = inputIsA ? poolState.tokenMint0 : poolState.tokenMint1;
    const outputMint = inputIsA ? poolState.tokenMint1 : poolState.tokenMint0;
    const inputDecimals = inputIsA ? poolState.decimals0 : poolState.decimals1;
    const outputDecimals = inputIsA ? poolState.decimals1 : poolState.decimals0;
    const inputUi = atomicToUi(amountInAtomic, inputDecimals);
    const outputUi = atomicToUi(amountOutAtomic, outputDecimals);
    const quoteUi = inputMint === pool.quoteMint ? inputUi : outputMint === pool.quoteMint ? outputUi : null;
    const assetUi = inputMint === pool.quoteMint ? outputUi : outputMint === pool.quoteMint ? inputUi : null;
    if (amountInAtomic <= 0n || amountOutAtomic <= 0n || inputUi === null || outputUi === null || quoteUi === null || assetUi === null || assetUi <= 0) continue;
    const tradeFeeAtomic = BigInt(inputIsA ? decoded.tradeFee0Atomic : decoded.tradeFee1Atomic);
    const feeSplit = splitOfficialFee(tradeFeeAtomic, configState);
    const lpFeeUi = atomicToUi(feeSplit.lpFee, inputDecimals);
    const priceUsd = quoteUi / assetUi;
    const feeUsd = lpFeeUi === null ? null : inputMint === pool.quoteMint ? lpFeeUi : lpFeeUi * priceUsd;
    if (feeUsd === null || !Number.isFinite(feeUsd)) continue;
    const location = instructionLocations[Math.min(eventIndex, Math.max(0, instructionLocations.length - 1))] ?? null;
    const instructionIndex = location?.instructionIndex ?? null;
    parsedEvents.push({
      eventKey: `${signature}:${instructionIndex ?? "unknown"}:${eventIndex}:${pool.poolAddress}`,
      poolAddress: pool.poolAddress,
      slot,
      signature,
      blockTime,
      blockTimeIso: new Date(blockTime * 1_000).toISOString(),
      instructionIndex,
      innerInstructionIndex: location?.innerInstructionIndex ?? null,
      eventIndex,
      programVersion: pool.programId,
      sender: decoded.sender,
      tokenAccount0: decoded.tokenAccount0,
      tokenAccount1: decoded.tokenAccount1,
      tokenMint0: poolState.tokenMint0,
      tokenMint1: poolState.tokenMint1,
      amount0Atomic: amount0.toString(),
      amount1Atomic: amount1.toString(),
      signedAmount0Atomic: (inputIsA ? amount0 : -amount0).toString(),
      signedAmount1Atomic: (inputIsA ? -amount1 : amount1).toString(),
      transferFee0Atomic: decoded.transferFee0Atomic,
      transferFee1Atomic: decoded.transferFee1Atomic,
      zeroForOne: inputIsA,
      inputMint,
      outputMint,
      amountInAtomic: amountInAtomic.toString(),
      amountOutAtomic: amountOutAtomic.toString(),
      sqrtPriceBefore: null,
      sqrtPriceAfter: decoded.sqrtPriceX64,
      tickBefore: null,
      tickAfter: decoded.tick,
      liquidityBefore: null,
      liquidityAfter: decoded.liquidity,
      initializedTicksCrossed: null,
      liquidityNetCrossed: null,
      tradeFee0Atomic: decoded.tradeFee0Atomic,
      tradeFee1Atomic: decoded.tradeFee1Atomic,
      tradeFeeAtomic: tradeFeeAtomic.toString(),
      protocolFeeAtomic: feeSplit.protocolFee.toString(),
      fundFeeAtomic: feeSplit.fundFee.toString(),
      lpFeeAtomic: feeSplit.lpFee.toString(),
      feeAtomic: feeSplit.lpFee.toString(),
      feeUsd,
      volumeUsd: quoteUi,
      priceUsd,
      baseFeeRate: normalizedFeeRate(poolState.feeRate),
      effectiveFeeRate: amountInAtomic > 0n ? Number(tradeFeeAtomic) / Number(amountInAtomic) : null,
      feeEvidence: "RAYDIUM_CLMM_SWAP_EVENT_PLUS_CONFIG_SPLIT",
      actualFeeEvidence: "OFFICIAL_SWAP_EVENT_TRADE_FEE",
      amountReconciliation: {
        status: reconciliationStatus,
        observedDelta0: delta0?.toString() ?? null,
        observedDelta1: delta1?.toString() ?? null,
        eventDelta0: eventDelta0.toString(),
        eventDelta1: eventDelta1.toString(),
        difference0: difference0?.toString() ?? null,
        difference1: difference1?.toString() ?? null,
      },
      parserVersion: SWAP_PARSER_VERSION,
    });
  }
  const metrics = {
    ...emptyParserMetrics(),
    containsTargetPool: 1,
    raydiumSwapCandidate: candidateCount,
    parsedSwap: parsedEvents.length,
    amountReconciliationFailed: reconciliationStatus === "FAIL" ? parsedEvents.length : 0,
    swapPathIncomplete: parsedEvents.length < candidateCount ? 1 : 0,
  };
  return {
    events: parsedEvents,
    reason: parsedEvents.length === candidateCount ? null : "SWAP_PATH_INCOMPLETE",
    metrics,
  };
}

function eventWindows(events, nowSeconds, checkpoint, evidenceConfig = {}) {
  const parserMetrics = (() => {
    try { return { ...emptyParserMetrics(), ...(checkpoint?.parserMetrics ?? {}) }; } catch { return emptyParserMetrics(); }
  })();
  return Object.fromEntries(WINDOW_HOURS.map((hours) => {
    const end = Math.floor(nowSeconds / 60) * 60;
    const start = end - hours * 3_600;
    const selected = events.filter((event) => event.blockTime >= start && event.blockTime < end);
    const oldestBlockTime = Number(checkpoint?.oldestBlockTime);
    const expectedBucketCount = hours * 60;
    const expectedSeconds = hours * 3_600;
    const replayCoverageThreshold = finite(evidenceConfig.replayCoverageThreshold) ?? 1;
    const pathCoverageThreshold = finite(evidenceConfig.pathCoverageThreshold) ?? 0.99;
    const feeCoverageThreshold = finite(evidenceConfig.feeCoverageThreshold) ?? 0.99;
    const bucketKeys = new Set(selected.map((event) => Math.floor(event.blockTime / 60) * 60));
    const gapCount = Number.isInteger(checkpoint?.gapCount) ? checkpoint.gapCount : null;
    const validSwaps = selected.filter((event) => event.pathStatus === "COMPLETE").length;
    const invalidSwaps = selected.length > 0 ? selected.length - validSwaps : 0;
    const pathCoverage = selected.length > 0 ? validSwaps / selected.length : null;
    const feeCoveredSwaps = selected.filter((event) => finite(event.feeUsd) !== null).length;
    const feeCoverage = selected.length > 0 ? feeCoveredSwaps / selected.length : null;
    const oldestBlock = Number.isFinite(oldestBlockTime) ? Math.max(start, Math.min(end, oldestBlockTime)) : null;
    const replayCoverageSeconds = oldestBlock === null ? 0 : Math.max(0, end - oldestBlock);
    const minuteBuckets = [];
    for (let bucket = start; bucket < end; bucket += 60) {
      const items = selected.filter((event) => Math.floor(event.blockTime / 60) * 60 === bucket);
      minuteBuckets.push({
        windowStart: new Date(bucket * 1_000).toISOString(),
        windowEnd: new Date((bucket + 60) * 1_000).toISOString(),
        volumeUsd: items.reduce((sum, event) => sum + (finite(event.volumeUsd) ?? 0), 0),
        lpFeeUsd: items.reduce((sum, event) => sum + (finite(event.feeUsd) ?? 0), 0),
        swapCount: items.length,
        zeroFilled: items.length === 0,
      });
    }
    const metricsBucketCount = minuteBuckets.length;
    const complete = checkpoint?.status === "COMPLETE"
      && Number.isFinite(oldestBlockTime)
      && oldestBlockTime <= start
      && Number(checkpoint?.unknownInstructions ?? 0) === 0
      && Number(checkpoint?.unresolvedRetryableTransactions ?? 0) === 0
      && gapCount === 0
      && metricsBucketCount >= expectedBucketCount
      && (replayCoverageSeconds / expectedSeconds) >= replayCoverageThreshold
      && (pathCoverage === null || pathCoverage >= pathCoverageThreshold)
      && (feeCoverage === null || feeCoverage >= feeCoverageThreshold)
      && parserMetrics.swapPathIncomplete === 0;
    return [String(hours), {
      windowStart: new Date(start * 1_000).toISOString(),
      windowEnd: new Date(end * 1_000).toISOString(),
      swaps: selected.length,
      volumeUsd: selected.reduce((sum, event) => sum + (finite(event.volumeUsd) ?? 0), 0),
      lpFeeUsd: selected.reduce((sum, event) => sum + (finite(event.feeUsd) ?? 0), 0),
      firstEventTime: selected[0]?.blockTimeIso ?? null,
      lastEventTime: selected.at(-1)?.blockTimeIso ?? null,
      coverageRatio: complete ? 1 : Math.min(1, replayCoverageSeconds / expectedSeconds),
      checkpointStatus: checkpoint?.status ?? "UNAVAILABLE",
      backfillStatus: complete ? "COMPLETE" : checkpoint?.status === "RPC_UNAVAILABLE" ? "RPC_UNAVAILABLE" : "INCOMPLETE",
      windowComplete: complete,
      expectedBucketCount,
      metricsBucketCount,
      observedEventBucketCount: bucketKeys.size,
      zeroFilledBucketCount: minuteBuckets.filter((bucket) => bucket.zeroFilled).length,
      gapCount,
      unknownInstructions: checkpoint?.unknownInstructions ?? null,
      unresolvedRetryableTransactions: checkpoint?.unresolvedRetryableTransactions ?? null,
      parserCoverageRatio: pathCoverage,
      replayCoverageSeconds,
      totalSwaps: selected.length,
      validSwaps,
      invalidSwaps,
      pathCoverage,
      feeCoverage,
      minuteBuckets,
    }];
  }));
}

function reconstructSwapPaths(events, poolState, tickArrays) {
  const slotSignatures = new Map();
  for (const event of events) {
    if (!slotSignatures.has(event.slot)) slotSignatures.set(event.slot, new Set());
    slotSignatures.get(event.slot).add(event.signature);
  }
  const orderIncompleteSlots = new Set([...slotSignatures.entries()]
    .filter(([slot, signatures]) => signatures.size > 1 && events.some((event) => event.slot === slot && !Number.isInteger(event.transactionIndex)))
    .map(([slot]) => slot));
  const compareNullable = (a, b) => {
    if (Number.isInteger(a) && Number.isInteger(b)) return a - b;
    if (Number.isInteger(a)) return -1;
    if (Number.isInteger(b)) return 1;
    return 0;
  };
  const ordered = [...events].sort((a, b) => {
    return a.slot - b.slot
      || compareNullable(a.transactionIndex, b.transactionIndex)
      || compareNullable(a.instructionIndex, b.instructionIndex)
      || compareNullable(a.innerInstructionIndex, b.innerInstructionIndex)
      || compareNullable(a.eventIndex, b.eventIndex)
      || String(a.signature).localeCompare(String(b.signature));
  });
  const initializedTicks = tickArrays?.initializedTicks ?? [];
  const tickCoverage = tickArrays?.coverage ?? null;
  const q64 = 1n << 64n;
  let valid = 0;
  let divergence = false;
  const reconstructed = ordered.map((event, index) => {
    const previous = ordered[index - 1] ?? null;
    let tickBefore = previous?.tickAfter ?? null;
    let sqrtPriceBefore = previous?.sqrtPriceAfter ?? null;
    let liquidityBefore = previous?.liquidityAfter ?? null;
    const tickAfter = finite(event.tickAfter);
    if (index === 0 && event.liquidityAfter !== null && event.sqrtPriceAfter !== null) {
      const liquidityAfter = BigInt(event.liquidityAfter);
      const amountIn = BigInt(event.amountInAtomic);
      const tradeFee = BigInt(event.tradeFeeAtomic);
      const netInput = amountIn - tradeFee;
      const amountOut = BigInt(event.amountOutAtomic);
      if (liquidityAfter > 0n && netInput > 0n && amountOut > 0n) {
        const after = BigInt(event.sqrtPriceAfter);
        // Reconstruct the initial sqrt price from the official event's fee-side
        // input.  For zero-for-one, the exact rearrangement is
        //   before = L*Q64*after / (L*Q64 - netInput*after)
        // rather than adding the output-side amount.  The latter loses the
        // program's integer rounding and made the first event look incomplete.
        const denominator = event.zeroForOne
          ? liquidityAfter * q64 - netInput * after
          : null;
        const candidate = event.zeroForOne
          ? denominator > 0n ? (liquidityAfter * q64 * after) / denominator : null
          : after - (netInput * q64 / liquidityAfter);
        if (candidate !== null && candidate > 0n) {
          const forward = event.zeroForOne
            ? (liquidityAfter * q64 * candidate) / (liquidityAfter * q64 + netInput * candidate)
            : candidate + netInput * q64 / liquidityAfter;
          if (forward !== null && (forward - after <= 1n && after - forward <= 1n)) {
            sqrtPriceBefore = candidate.toString();
            try { tickBefore = TickUtil.getTickAtSqrtPrice(new BN(candidate.toString())); } catch { tickBefore = null; }
            liquidityBefore = event.liquidityAfter;
          }
        }
      }
    }
    const crossed = tickBefore === null || tickAfter === null
      ? null
      : initializedTicks.filter((tick) => (event.zeroForOne ? tick.tick < tickBefore && tick.tick >= tickAfter : tick.tick > tickBefore && tick.tick <= tickAfter));
    const directionPass = tickBefore === null || tickAfter === null
      ? false
      : event.zeroForOne ? tickAfter <= tickBefore : tickAfter >= tickBefore;
    const tickPathCovered = Boolean(tickCoverage
      && tickBefore !== null
      && tickAfter !== null
      && tickBefore >= tickCoverage.lower
      && tickBefore <= tickCoverage.upper
      && tickAfter >= tickCoverage.lower
      && tickAfter <= tickCoverage.upper);
    const liquidityNet = crossed?.reduce((sum, tick) => sum + BigInt(tick.liquidityNet), 0n) ?? null;
    const expectedLiquidityAfter = liquidityBefore === null || liquidityNet === null
      ? null
      : event.zeroForOne ? BigInt(liquidityBefore) - liquidityNet : BigInt(liquidityBefore) + liquidityNet;
    const liquidityTransitionPass = expectedLiquidityAfter !== null && expectedLiquidityAfter.toString() === event.liquidityAfter;
    const transactionOrderPass = !orderIncompleteSlots.has(event.slot);
    const pathStatus = sqrtPriceBefore !== null && tickBefore !== null && liquidityBefore !== null && transactionOrderPass && directionPass && tickPathCovered && liquidityTransitionPass
      ? "COMPLETE"
      : "SWAP_PATH_INCOMPLETE";
    if (pathStatus === "COMPLETE") valid += 1;
    return {
      ...event,
      sqrtPriceBefore,
      tickBefore,
      liquidityBefore,
      initializedTicksCrossed: crossed?.map((tick) => tick.tick) ?? null,
      liquidityNetCrossed: crossed?.map((tick) => tick.liquidityNet) ?? null,
      pathStatus,
      pathReason: pathStatus === "COMPLETE" ? null : !transactionOrderPass ? "TRANSACTION_ORDER_UNAVAILABLE" : tickBefore === null ? "INITIAL_STATE_UNAVAILABLE" : !tickPathCovered ? "TICK_ARRAY_COVERAGE_INCOMPLETE" : !liquidityTransitionPass ? "LIQUIDITY_TRANSITION_MISMATCH" : "STATE_DIRECTION_OR_FIELD_INVALID",
      transactionOrderPass,
    };
  });
  const last = reconstructed.at(-1);
  const stateSlot = finite(poolState?.slot);
  const lastEventSlot = finite(last?.slot);
  const currentStateAfterReplay = Boolean(stateSlot !== null && lastEventSlot !== null && stateSlot > lastEventSlot);
  const currentMatchesLast = currentStateAfterReplay ? null : Boolean(last
    && last.sqrtPriceAfter === poolState?.sqrtPriceX64
    && last.tickAfter === poolState?.tickCurrent
    && last.liquidityAfter === poolState?.liquidity);
  if (last && currentStateAfterReplay !== true && currentMatchesLast !== true) divergence = true;
  const total = reconstructed.length;
  return {
    events: reconstructed,
    valid,
    total,
    coverageRatio: total > 0 ? valid / total : null,
    currentMatchesLast,
    currentStateAfterReplay,
    divergence,
    transactionOrderComplete: orderIncompleteSlots.size === 0,
    orderIncompleteSlots: [...orderIncompleteSlots],
    stateContinuityPass: !divergence && reconstructed.slice(1).every((event, index) => event.sqrtPriceBefore === reconstructed[index].sqrtPriceAfter && event.tickBefore === reconstructed[index].tickAfter && event.liquidityBefore === reconstructed[index].liquidityAfter),
    pass: !divergence && orderIncompleteSlots.size === 0 && valid === total && total > 0,
  };
}

function priceFromSqrt(sqrtPriceX64, pool, poolState) {
  try {
    const raw = Number(TickUtil.sqrtPriceX64ToPrice(new BN(String(sqrtPriceX64)), poolState.mintDecimals0, poolState.mintDecimals1).toString());
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return poolState.tokenMint0 === pool.quoteMint ? 1 / raw : raw;
  } catch {
    return null;
  }
}

function shadowLiquidityAtState(capital, priceUsd, range, pool, poolState, sqrtPriceX64) {
  if (!Number.isFinite(capital) || capital <= 0 || !Number.isFinite(priceUsd) || priceUsd <= 0 || !range || sqrtPriceX64 === null) return null;
  try {
    const quoteAtomic = BigInt(Math.max(0, Math.round((capital / 2) * (10 ** pool.quoteDecimals))));
    const assetAtomic = BigInt(Math.max(0, Math.round((capital / 2 / priceUsd) * (10 ** pool.assetDecimals))));
    const amount0 = poolState.tokenMint0 === pool.quoteMint ? quoteAtomic : assetAtomic;
    const amount1 = poolState.tokenMint1 === pool.quoteMint ? quoteAtomic : assetAtomic;
    const current = new BN(String(sqrtPriceX64));
    const lower = TickUtil.getSqrtPriceAtTick(range.tickLower);
    const upper = TickUtil.getSqrtPriceAtTick(range.tickUpper);
    const liquidity = LiquidityMathUtil.getLiquidityFromAmounts(current, lower, upper, new BN(amount0.toString()), new BN(amount1.toString()));
    return liquidity.gt(new BN(0)) ? liquidity.toString() : null;
  } catch {
    return null;
  }
}

function shadowAmountsAtState(liquidity, range, poolState, sqrtPriceX64) {
  if (liquidity === null || !range || sqrtPriceX64 === null) return null;
  try {
    const current = new BN(String(sqrtPriceX64));
    const lower = TickUtil.getSqrtPriceAtTick(range.tickLower);
    const upper = TickUtil.getSqrtPriceAtTick(range.tickUpper);
    const amounts = LiquidityMathUtil.getAmountsForLiquidity(current, lower, upper, new BN(String(liquidity)), false);
    return {
      amount0Atomic: amounts.amountA.toString(),
      amount1Atomic: amounts.amountB.toString(),
    };
  } catch {
    return null;
  }
}

function shadowValueUsd(amounts, priceUsd, pool, poolState) {
  if (!amounts || !Number.isFinite(priceUsd) || priceUsd <= 0) return null;
  const decimals0 = poolState.decimals0 ?? poolState.mintDecimals0;
  const decimals1 = poolState.decimals1 ?? poolState.mintDecimals1;
  if (!Number.isInteger(decimals0) || !Number.isInteger(decimals1)) return null;
  const amount0 = Number(BigInt(amounts.amount0Atomic)) / (10 ** decimals0);
  const amount1 = Number(BigInt(amounts.amount1Atomic)) / (10 ** decimals1);
  if (!Number.isFinite(amount0) || !Number.isFinite(amount1)) return null;
  return poolState.tokenMint0 === pool.quoteMint ? amount0 + amount1 * priceUsd : amount1 + amount0 * priceUsd;
}

function rangeIsActive(tick, range) {
  return Number.isFinite(tick) && Number.isFinite(range?.tickLower) && Number.isFinite(range?.tickUpper)
    && tick >= range.tickLower && tick < range.tickUpper;
}

function buildShadowReplay(pool, poolState, events, pathEvidence, tickArrays, windows) {
  const base = {
    status: "INCOMPLETE",
    candidates: {},
    eventsTotal: pathEvidence?.total ?? events.length,
    eventsValid: pathEvidence?.valid ?? 0,
    pathCoverageRatio: pathEvidence?.coverageRatio ?? null,
    feeAllocationMethod: "OFFICIAL_SWAP_EVENT_LP_FEE × L_SHADOW / (L_HISTORICAL + L_SHADOW)",
    selfDilutionIncludedInShare: true,
    blockers: [],
  };
  if (pathEvidence?.pass !== true) {
    return { ...base, blockers: [pathEvidence?.divergence ? "REPLAY_STATE_DIVERGENCE" : "SWAP_TICK_PATH_UNAVAILABLE"] };
  }
  if (!poolState?.poolStatePass || !tickArrays?.tickArrayPass || events.length === 0) {
    return { ...base, blockers: ["REPLAY_STATE_INCOMPLETE"] };
  }
  const candidates = buildStrategyCandidates({
    coreWidths: [0.0025, 0.005, 0.0075, 0.01, 0.015, 0.02],
    bufferWidths: [0.02, 0.03, 0.05, 0.075, 0.1],
    allocations: [{ core: 0.8, buffer: 0.2 }, { core: 0.7, buffer: 0.3 }, { core: 0.6, buffer: 0.4 }],
    capital: 1_000,
  });
  // Crossed initialized ticks are part of the official CLMM path. The path
  // reconstruction above has already verified their liquidity transition, so
  // they must remain in the shadow replay instead of being silently dropped.
  const pathEvents = events.filter((event) => event.pathStatus === "COMPLETE");
  if (pathEvents.length !== events.length) return { ...base, blockers: ["HISTORICAL_ACTIVE_LIQUIDITY_PATH_INCOMPLETE"] };
  const first = pathEvents[0];
  const last = pathEvents.at(-1);
  const window24 = windows?.["24"];
  const windowStart = Number.isFinite(Date.parse(window24?.windowStart)) ? Date.parse(window24.windowStart) / 1_000 : first.blockTime;
  const windowEnd = Number.isFinite(Date.parse(window24?.windowEnd)) ? Date.parse(window24.windowEnd) / 1_000 : last.blockTime;
  const addActiveSeconds = (counter, tick, from, to, range) => {
    const seconds = Math.max(0, Math.min(windowEnd, to) - Math.max(windowStart, from));
    if (seconds > 0 && rangeIsActive(tick, range)) counter.value += seconds;
  };
  for (const candidate of candidates) {
    const core = snapRange({ width: candidate.coreWidth }, { currentTick: poolState.tickCurrent, tickSpacing: poolState.tickSpacing, currentPrice: poolState.currentPrice, tickDirection: pool.tickDirection });
    const buffer = snapRange({ width: candidate.bufferWidth }, { currentTick: poolState.tickCurrent, tickSpacing: poolState.tickSpacing, currentPrice: poolState.currentPrice, tickDirection: pool.tickDirection });
    if (!core || !buffer) continue;
    const initialPrice = priceFromSqrt(first.sqrtPriceBefore, pool, poolState);
    const coreLiquidity = shadowLiquidityAtState(candidate.coreCapital, initialPrice, core, pool, poolState, first.sqrtPriceBefore);
    const bufferLiquidity = shadowLiquidityAtState(candidate.bufferCapital, initialPrice, buffer, pool, poolState, first.sqrtPriceBefore);
    let coreCapturedFee = 0;
    let bufferCapturedFee = 0;
    const coreActiveSeconds = { value: 0 };
    const bufferActiveSeconds = { value: 0 };
    let coreRebalanceCount = 0;
    let bufferRebalanceCount = 0;
    let previousCoreActive = rangeIsActive(first.tickBefore, core);
    let previousBufferActive = rangeIsActive(first.tickBefore, buffer);
    let feeEvents = 0;
    let complete = true;
    for (let index = 0; index < pathEvents.length; index += 1) {
      const event = pathEvents[index];
      const next = pathEvents[index + 1];
      const price = priceFromSqrt(event.sqrtPriceBefore, pool, poolState);
      const shadowCore = coreLiquidity;
      const shadowBuffer = bufferLiquidity;
      const historicalLiquidity = BigInt(event.liquidityBefore);
      const coreAmounts = shadowAmountsAtState(shadowCore, core, poolState, event.sqrtPriceBefore);
      const bufferAmounts = shadowAmountsAtState(shadowBuffer, buffer, poolState, event.sqrtPriceBefore);
      if (price === null || shadowCore === null || shadowBuffer === null || coreAmounts === null || bufferAmounts === null || historicalLiquidity <= 0n || finite(event.feeUsd) === null) {
        complete = false;
        break;
      }
      const coreActive = rangeIsActive(event.tickBefore, core);
      const bufferActive = rangeIsActive(event.tickBefore, buffer);
      const coreShare = coreActive ? Number(BigInt(shadowCore) * 1_000_000n / (historicalLiquidity + BigInt(shadowCore))) / 1_000_000 : 0;
      const bufferShare = bufferActive ? Number(BigInt(shadowBuffer) * 1_000_000n / (historicalLiquidity + BigInt(shadowBuffer))) / 1_000_000 : 0;
      coreCapturedFee += event.feeUsd * coreShare;
      bufferCapturedFee += event.feeUsd * bufferShare;
      feeEvents += 1;
      if (next) {
        addActiveSeconds(coreActiveSeconds, event.tickAfter, event.blockTime, next.blockTime, core);
        addActiveSeconds(bufferActiveSeconds, event.tickAfter, event.blockTime, next.blockTime, buffer);
        if (previousCoreActive && !rangeIsActive(next.tickBefore, core)) coreRebalanceCount += 1;
        if (previousBufferActive && !rangeIsActive(next.tickBefore, buffer)) bufferRebalanceCount += 1;
        previousCoreActive = rangeIsActive(next.tickBefore, core);
        previousBufferActive = rangeIsActive(next.tickBefore, buffer);
      }
    }
    if (complete) {
      addActiveSeconds(coreActiveSeconds, first.tickBefore, windowStart, first.blockTime, core);
      addActiveSeconds(bufferActiveSeconds, first.tickBefore, windowStart, first.blockTime, buffer);
      addActiveSeconds(coreActiveSeconds, last.tickAfter, last.blockTime, windowEnd, core);
      addActiveSeconds(bufferActiveSeconds, last.tickAfter, last.blockTime, windowEnd, buffer);
      const finalPrice = priceFromSqrt(last.sqrtPriceAfter, pool, poolState);
      const initialCoreAmounts = shadowAmountsAtState(coreLiquidity, core, poolState, first.sqrtPriceBefore);
      const finalCoreAmounts = shadowAmountsAtState(coreLiquidity, core, poolState, last.sqrtPriceAfter);
      const initialBufferAmounts = shadowAmountsAtState(bufferLiquidity, buffer, poolState, first.sqrtPriceBefore);
      const finalBufferAmounts = shadowAmountsAtState(bufferLiquidity, buffer, poolState, last.sqrtPriceAfter);
      if (finalPrice === null || initialCoreAmounts === null || finalCoreAmounts === null || initialBufferAmounts === null || finalBufferAmounts === null) continue;
      const initialCoreValue = shadowValueUsd(initialCoreAmounts, initialPrice, pool, poolState);
      const initialBufferValue = shadowValueUsd(initialBufferAmounts, initialPrice, pool, poolState);
      const finalCoreValue = shadowValueUsd(finalCoreAmounts, finalPrice, pool, poolState);
      const finalBufferValue = shadowValueUsd(finalBufferAmounts, finalPrice, pool, poolState);
      if ([initialCoreValue, initialBufferValue, finalCoreValue, finalBufferValue].some((value) => value === null)) continue;
      const initialValue = initialCoreValue + initialBufferValue;
      const finalValue = finalCoreValue + finalBufferValue;
      const decimals0 = poolState.decimals0 ?? poolState.mintDecimals0;
      const decimals1 = poolState.decimals1 ?? poolState.mintDecimals1;
      const token0IsQuote = poolState.tokenMint0 === pool.quoteMint;
      const initialQuote = token0IsQuote
        ? (Number(BigInt(initialCoreAmounts?.amount0Atomic ?? "0")) + Number(BigInt(initialBufferAmounts?.amount0Atomic ?? "0"))) / (10 ** decimals0)
        : (Number(BigInt(initialCoreAmounts?.amount1Atomic ?? "0")) + Number(BigInt(initialBufferAmounts?.amount1Atomic ?? "0"))) / (10 ** decimals1);
      const initialAsset = token0IsQuote
        ? (Number(BigInt(initialCoreAmounts?.amount1Atomic ?? "0")) + Number(BigInt(initialBufferAmounts?.amount1Atomic ?? "0"))) / (10 ** decimals1)
        : (Number(BigInt(initialCoreAmounts?.amount0Atomic ?? "0")) + Number(BigInt(initialBufferAmounts?.amount0Atomic ?? "0"))) / (10 ** decimals0);
      const holdValue = finalPrice === null ? null : initialQuote + initialAsset * finalPrice;
      const impermanentLoss = holdValue === null ? null : Math.max(0, holdValue - finalValue);
      const observedSeconds = Math.max(0, windowEnd - windowStart);
      const totalRebalances = coreRebalanceCount + bufferRebalanceCount;
      base.candidates[candidate.id] = {
        coreActiveTimeRatio: observedSeconds > 0 ? coreActiveSeconds.value / observedSeconds : null,
        bufferActiveTimeRatio: observedSeconds > 0 ? bufferActiveSeconds.value / observedSeconds : null,
        coreCapturedFee,
        bufferCapturedFee,
        selfDilution: 0,
        grossFee24h: coreCapturedFee + bufferCapturedFee,
        rebalanceFrequency: observedSeconds > 0 ? totalRebalances / (observedSeconds / 86_400) : null,
        rebalanceCount24h: totalRebalances,
        coreRebalanceCount24h: coreRebalanceCount,
        bufferRebalanceCount24h: bufferRebalanceCount,
        rebalanceSwapCost: null,
        slippage: null,
        transactionCost: null,
        inventoryChange: Number.isFinite(finalValue - initialValue) ? finalValue - initialValue : null,
        impermanentLoss,
        toxicMarkout: null,
        feeCoverage: pathEvents.length > 0 ? feeEvents / pathEvents.length : null,
        crossedTickEventCount: pathEvents.filter((event) => (event.initializedTicksCrossed?.length ?? 0) > 0).length,
        quality: "SHADOW_FEE_IL_REPLAY_PENDING_COST_MARKOUT",
      };
    }
  }
  const candidateCount = Object.keys(base.candidates).length;
  return {
    ...base,
    status: candidateCount > 0 ? "SHADOW_FEE_REPLAY_COMPLETE_NET_PENDING" : "INCOMPLETE",
    candidateCount,
    blockers: candidateCount > 0 ? ["EXECUTION_COST_UNAVAILABLE", "MARKOUT_UNAVAILABLE"] : ["SHADOW_REPLAY_INPUT_UNAVAILABLE"],
  };
}

function buildReplayEvidence(poolState, tickArrays, events, windows, pathEvidence, shadowReplay, executionCostEvidence, markout) {
  if (!poolState?.poolStatePass || !tickArrays?.tickArrayPass || events.length === 0) return { replayEvidence: null, blocker: "REPLAY_STATE_INCOMPLETE" };
  if (pathEvidence?.divergence) return { replayEvidence: null, blocker: "REPLAY_STATE_DIVERGENCE" };
  if (pathEvidence?.pass !== true) return { replayEvidence: null, blocker: "SWAP_TICK_PATH_UNAVAILABLE" };
  if (!WINDOW_HOURS.every((hours) => windows[String(hours)]?.backfillStatus === "COMPLETE")) return { replayEvidence: null, blocker: "SWAP_BACKFILL_INCOMPLETE" };
  if (shadowReplay?.status !== "SHADOW_FEE_REPLAY_COMPLETE_NET_PENDING" || shadowReplay.candidateCount <= 0) {
    return { replayEvidence: null, blocker: "SHADOW_REPLAY_INPUT_UNAVAILABLE" };
  }

  const actionCost = (action) => finite(executionCostEvidence?.actions?.[action]?.totalUsd);
  const openCost = actionCost("OPEN");
  const moveCoreCost = actionCost("MOVE_CORE");
  const moveBothCost = actionCost("MOVE_BOTH");
  const markoutLoss = markout?.quality === "COMPLETE" ? finite(markout.lossUsd24h) : null;
  const candidates = {};
  for (const [candidateId, shadow] of Object.entries(shadowReplay.candidates ?? {})) {
    const coreMoves = Number(shadow.coreRebalanceCount24h ?? 0);
    const bufferMoves = Number(shadow.bufferRebalanceCount24h ?? 0);
    const pairedMoves = Math.min(coreMoves, bufferMoves);
    const standaloneMoves = coreMoves + bufferMoves - pairedMoves;
    const rebalanceSwapCost = moveBothCost === null || moveCoreCost === null
      ? null
      : pairedMoves * moveBothCost + standaloneMoves * moveCoreCost;
    const transactionCost = openCost === null || rebalanceSwapCost === null ? null : openCost + rebalanceSwapCost;
    const slippage = shadow.rebalanceCount24h === 0 ? 0 : null;
    const blockers = [];
    if (transactionCost === null) blockers.push("EXECUTION_COST_UNAVAILABLE");
    if (slippage === null) blockers.push("REBALANCE_SLIPPAGE_UNAVAILABLE");
    if (markoutLoss === null) blockers.push("MARKOUT_UNAVAILABLE");
    candidates[candidateId] = {
      ...shadow,
      rebalanceSwapCost,
      slippage,
      transactionCost,
      toxicMarkout: markoutLoss,
      blockers,
      selfDilutionAccounting: "INCLUDED_IN_PER_SWAP_SHARE",
      accountingQuality: blockers.length === 0 ? "COMPLETE" : "PARTIAL",
    };
  }
  return {
    replayEvidence: {
      method: "RAYDIUM_SWAP_EVENT_PLUS_OFFICIAL_TICK_PATH_AND_HISTORICAL_ACTIVE_LIQUIDITY",
      candidates,
      selfDilutionIncluded: true,
      feeSource: "OFFICIAL_SWAP_EVENT_TRADE_FEE_SPLIT",
      historicalActiveLiquiditySource: "RECONSTRUCTED_SWAP_STATE",
      executionCostQuality: executionCostEvidence?.quality ?? "UNAVAILABLE",
      markoutQuality: markout?.quality ?? "INCOMPLETE",
      feeGrowthValidation: "SEPARATE_RECONCILIATION_LAYER",
      blockers: [...new Set(Object.values(candidates).flatMap((candidate) => candidate.blockers ?? []))],
    },
    blocker: null,
  };
}

async function collectPoolEvidence(client, store, pool, config, nowSeconds, executionCostEvidence) {
  const stateResult = await readPoolState(client, pool);
  if (!stateResult.poolState) {
    const previous = store.readPoolEvidence(pool.poolAddress);
    return previous ?? {
      poolAddress: pool.poolAddress,
      activeIndexed: false,
      blockers: [stateResult.error ?? "POOL_STATE_UNAVAILABLE"],
      updatedAt: new Date().toISOString(),
    };
  }
  const poolState = { ...stateResult.poolState, tickDirection: pool.assetIsToken0 ? 1 : -1, decimals0: pool.apiDecimalsA, decimals1: pool.apiDecimalsB, feeRate: stateResult.poolState.feeRate, currentPrice: stateResult.poolState.currentPrice };
  const tickResult = await readTickArrays(client, pool, poolState);
  const checkpoint = store.readCheckpoint(pool.poolAddress);
  const since = nowSeconds - 24 * 3_600;
  const signatureResult = await collectPoolSignatures(client, store, pool, poolState, checkpoint, config, since);
  const parsedEvents = await resolveSlotTransactionOrders(client, store.readSwaps(pool.poolAddress, since));
  for (const event of parsedEvents) store.writeSwap(event);
  const refreshedStateResult = await readPoolState(client, pool, { forceRefresh: true });
  const replayPoolState = refreshedStateResult.poolState ?? poolState;
  const refreshedTickResult = refreshedStateResult.poolState
    ? await readTickArrays(client, pool, { ...refreshedStateResult.poolState, tickDirection: pool.assetIsToken0 ? 1 : -1, decimals0: pool.apiDecimalsA, decimals1: pool.apiDecimalsB, feeRate: refreshedStateResult.poolState.feeRate, currentPrice: refreshedStateResult.poolState.currentPrice })
    : tickResult;
  const pathEvidence = reconstructSwapPaths(store.readSwaps(pool.poolAddress, since), replayPoolState, refreshedTickResult.tickArrays);
  for (const event of pathEvidence.events) store.writeSwap(event);
  const events = store.readSwaps(pool.poolAddress, since);
  const windows = eventWindows(events, nowSeconds, { ...signatureResult.checkpoint, parserMetrics: signatureResult.checkpoint.parserMetrics }, config.evidence);
  store.writeWindowCoverage(pool.poolAddress, windows);
  const shadowReplay = buildShadowReplay(pool, replayPoolState, events, pathEvidence, refreshedTickResult.tickArrays, windows);
  const markout = {
    quality: "INCOMPLETE",
    source: null,
    horizons: { plus30s: null, plus1m: null, plus5m: null },
    lossUsd24h: null,
    blockers: ["EXTERNAL_RWA_REFERENCE_UNAVAILABLE"],
  };
  const replayFeeUsd = events.reduce((sum, event) => sum + (finite(event.feeUsd) ?? 0), 0);
  const feeGrowthReconciliation = {
    status: "UNAVAILABLE",
    replayFeeUsd,
    feeGrowthExpected: null,
    diffBps: null,
    toleranceBps: 5,
    reason: "历史 PoolState / Tick feeGrowth delta 尚未按每个窗口持久化，当前状态不能反推历史 delta",
  };
  const replay = buildReplayEvidence(replayPoolState, refreshedTickResult.tickArrays, events, windows, pathEvidence, shadowReplay, executionCostEvidence, markout);
  const swapIndexPass = signatureResult.checkpoint.status === "COMPLETE"
    && signatureResult.checkpoint.unknownInstructions === 0
    && signatureResult.checkpoint.unresolvedRetryableTransactions === 0;
  const activeIndexed = replayPoolState.poolStatePass && refreshedTickResult.tickArrays?.tickArrayPass === true && swapIndexPass;
  const blockers = unique([
    ...replayPoolState.blockers,
    ...(refreshedTickResult.error ? [refreshedTickResult.error] : []),
    ...(signatureResult.blockers ?? []),
    ...(pathEvidence.divergence ? ["REPLAY_STATE_DIVERGENCE"] : []),
    ...(pathEvidence.pass !== true ? ["SWAP_TICK_PATH_UNAVAILABLE"] : []),
    ...(replay.blocker ? [replay.blocker] : []),
  ]);
  const evidence = {
    poolAddress: pool.poolAddress,
    activeIndexed,
    poolState: replayPoolState,
    tickArrays: refreshedTickResult.tickArrays,
    swaps: {
      windows,
      count24h: events.length,
      lastSwapTime: events.at(-1)?.blockTimeIso ?? null,
      parser: signatureResult.checkpoint.parserMetrics,
      path: {
        total: pathEvidence.total,
        valid: pathEvidence.valid,
        coverageRatio: pathEvidence.coverageRatio,
        currentMatchesLast: pathEvidence.currentMatchesLast,
        currentStateAfterReplay: pathEvidence.currentStateAfterReplay,
        stateContinuityPass: pathEvidence.stateContinuityPass,
        divergence: pathEvidence.divergence,
        transactionOrderComplete: pathEvidence.transactionOrderComplete,
        orderIncompleteSlots: pathEvidence.orderIncompleteSlots,
        pass: pathEvidence.pass,
      },
    },
    replayEvidence: replay.replayEvidence,
    shadowReplay,
    markout,
    feeGrowthReconciliation,
    swapIndexPass,
    feeConfigVerified: replayPoolState.configPass,
    executionCosts: executionCostEvidence?.quality === "UNAVAILABLE" ? null : executionCostEvidence,
    executionCostEvidence,
    checkpoints: signatureResult.checkpoint,
    blockers,
    dataFreshness: { state: "FRESH", observedAt: new Date().toISOString(), maxAgeMs: config.evidence.freshnessSlaMs },
    updatedAt: new Date().toISOString(),
  };
  store.writePoolEvidence(pool.poolAddress, evidence);
  return evidence;
}

async function collectPoolSignatures(client, store, pool, poolState, checkpointRow, config, sinceSeconds) {
  const checkpoint = {
    beforeSignature: checkpointRow?.before_signature ?? null,
    newestSignature: checkpointRow?.newest_signature ?? null,
    oldestBlockTime: checkpointRow?.oldest_block_time ?? null,
    lastSeenSlot: checkpointRow?.last_seen_slot ?? null,
    signaturesDiscovered: checkpointRow?.signatures_discovered ?? 0,
    transactionsFetched: checkpointRow?.transactions_fetched ?? 0,
    transactionsSuccessful: checkpointRow?.transactions_successful ?? 0,
    transactionsFailed: checkpointRow?.transactions_failed ?? 0,
    unresolvedRetryableTransactions: checkpointRow?.unresolved_retryable_transactions ?? 0,
    gapCount: checkpointRow?.gap_count ?? null,
    swapsParsed: checkpointRow?.swaps_parsed ?? 0,
    unknownInstructions: checkpointRow?.unknown_instructions ?? 0,
    parserMetrics: (() => {
      try {
        return { ...emptyParserMetrics(), ...(checkpointRow?.parser_metrics_json ? JSON.parse(String(checkpointRow.parser_metrics_json)) : {}) };
      } catch {
        return emptyParserMetrics();
      }
    })(),
    status: checkpointRow?.status ?? "BACKFILLING",
  };
  checkpoint.parserMetrics = emptyParserMetrics();
  checkpoint.unresolvedRetryableTransactions = store.countRetryableTransactions(pool.poolAddress, sinceSeconds);
  const signatures = [];
  // A prior COMPLETE checkpoint is only a historical fact. Every fresh run
  // rescans from the head so the requested 24h boundary is proved again.
  let before = checkpoint.status === "COMPLETE" ? null : checkpoint.beforeSignature;
  let complete = false;
  for (let page = 0; page < config.evidence.maxSignaturePagesPerPool; page += 1) {
    const params = [pool.poolAddress, { limit: config.evidence.signaturePageLimit, commitment: "confirmed", ...(before ? { before } : {}) }];
    const response = await client.request("getSignaturesForAddress", params, {
      cacheKey: `signatures:${pool.poolAddress}:${before ?? "latest"}`,
      cacheTtlMs: checkpoint.status === "COMPLETE" ? 0 : 10_000,
    });
    if (response.error || !Array.isArray(response.result)) {
      checkpoint.status = "RPC_UNAVAILABLE";
      break;
    }
    const rows = response.result.filter((row) => typeof row?.signature === "string");
    if (rows.length === 0) { complete = true; break; }
    signatures.push(...rows);
    const oldest = rows.at(-1);
    const oldestTime = typeof oldest?.blockTime === "number" ? oldest.blockTime : null;
    if (oldestTime !== null && oldestTime <= sinceSeconds) { complete = true; break; }
    before = oldest.signature;
    checkpoint.beforeSignature = before;
    if (rows.length < config.evidence.signaturePageLimit) {
      complete = oldestTime !== null && oldestTime <= sinceSeconds;
      break;
    }
  }
  const uniqueSignatures = [...new Map(signatures.map((row) => [row.signature, row])).values()]
    .slice(0, config.evidence.maxTransactionsPerPool);
  if (uniqueSignatures.length > 0 && checkpoint.newestSignature === null) checkpoint.newestSignature = uniqueSignatures[0].signature;
  for (const item of uniqueSignatures) {
    if (typeof item.slot === "number") checkpoint.lastSeenSlot = Math.max(checkpoint.lastSeenSlot ?? 0, item.slot);
    if (typeof item.blockTime === "number") checkpoint.oldestBlockTime = checkpoint.oldestBlockTime === null ? item.blockTime : Math.min(checkpoint.oldestBlockTime, item.blockTime);
    if (typeof item.blockTime === "number" && item.blockTime < sinceSeconds) continue;
    checkpoint.signaturesDiscovered += 1;
    if (item.err) {
      checkpoint.parserMetrics.signatureErrorsSkipped += 1;
      continue;
    }
    const cached = store.readTransaction(item.signature);
    let transaction = cached?.status === "SUCCESS" ? cached.payload : null;
    if (!transaction) {
      const response = await client.request("getTransaction", [item.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
      checkpoint.transactionsFetched += 1;
      if (response.error || !response.result) {
        checkpoint.transactionsFailed += 1;
        const retryable = true;
        checkpoint.unresolvedRetryableTransactions += retryable ? 1 : 0;
        store.writeTransaction(item.signature, { poolAddress: pool.poolAddress, slot: item.slot, blockTime: item.blockTime, payload: null, status: "FAILED", error: response.error ?? "TRANSACTION_NULL", retryable });
        continue;
      }
      transaction = response.result;
      checkpoint.transactionsSuccessful += 1;
      if (cached?.status === "FAILED" && cached.retryable) {
        checkpoint.unresolvedRetryableTransactions = Math.max(0, checkpoint.unresolvedRetryableTransactions - 1);
      }
      store.writeTransaction(item.signature, { poolAddress: pool.poolAddress, slot: transaction.slot ?? item.slot, blockTime: transaction.blockTime ?? item.blockTime, payload: transaction, status: "SUCCESS", error: null, retryable: false });
    }
    if (transaction) {
      checkpoint.parserMetrics.transactionsLoaded += 1;
      if (!transaction.meta?.err) checkpoint.parserMetrics.onchainSuccess += 1;
    }
    const parsed = parseSwapTransaction(transaction, pool, { ...poolState, tokenMint0: poolState.tokenMint0, tokenMint1: poolState.tokenMint1, decimals0: poolState.decimals0, decimals1: poolState.decimals1, vault0: poolState.vault0, vault1: poolState.vault1, feeRate: poolState.feeRate }, poolState, item.signature);
    for (const [key, value] of Object.entries(parsed.metrics ?? {})) checkpoint.parserMetrics[key] = (checkpoint.parserMetrics[key] ?? 0) + value;
    if (parsed.events?.length > 0) {
      for (const event of parsed.events) store.writeSwap(event);
    } else if (parsed.reason === "NOT_TARGET_RAYDIUM_SWAP" || parsed.reason === "TRANSACTION_FAILED") {
      // A signature for the pool is not necessarily a CLMM swap; this is not an unknown instruction.
    } else if (parsed.reason !== "SWAP_PATH_INCOMPLETE" && parsed.reason !== "AMOUNT_RECONCILIATION_FAILED") {
      checkpoint.unknownInstructions += 1;
    }
  }
  checkpoint.swapsParsed = store.countSwaps(pool.poolAddress, sinceSeconds);
  checkpoint.parserMetrics.normalizedSwaps = checkpoint.swapsParsed;
  checkpoint.unresolvedRetryableTransactions = store.countRetryableTransactions(pool.poolAddress, sinceSeconds);
  checkpoint.gapCount = complete && checkpoint.status !== "RPC_UNAVAILABLE" ? 0 : null;
  checkpoint.status = complete && checkpoint.unresolvedRetryableTransactions === 0
    ? "COMPLETE"
    : checkpoint.status === "RPC_UNAVAILABLE" ? checkpoint.status : "BACKFILLING";
  store.writeCheckpoint(pool.poolAddress, checkpoint);
  return { checkpoint, blockers: checkpoint.status === "COMPLETE" ? [] : ["SWAP_BACKFILL_INCOMPLETE"] };
}

async function resolveSlotTransactionOrders(client, events) {
  const signaturesBySlot = new Map();
  for (const event of events) {
    if (!Number.isInteger(event.slot) || typeof event.signature !== "string") continue;
    if (!signaturesBySlot.has(event.slot)) signaturesBySlot.set(event.slot, new Set());
    signaturesBySlot.get(event.slot).add(event.signature);
  }
  const orderBySignature = new Map();
  const statusBySignature = new Map();
  for (const [slot, signatures] of signaturesBySlot.entries()) {
    if (signatures.size === 1) {
      const [signature] = signatures;
      orderBySignature.set(signature, 0);
      statusBySignature.set(signature, "SINGLE_SIGNATURE_SLOT");
      continue;
    }
    const response = await client.request("getBlock", [slot, {
      commitment: "confirmed",
      transactionDetails: "signatures",
      rewards: false,
    }], { cacheKey: `block-signatures:${slot}`, cacheTtlMs: 24 * 60 * 60_000 });
    const blockSignatures = Array.isArray(response.result?.signatures) ? response.result.signatures : [];
    const indexes = new Map(blockSignatures.map((signature, index) => [signature, index]));
    for (const signature of signatures) {
      if (indexes.has(signature)) {
        orderBySignature.set(signature, indexes.get(signature));
        statusBySignature.set(signature, "BLOCK_SIGNATURE_ORDER");
      } else {
        statusBySignature.set(signature, response.error ? "BLOCK_ORDER_RPC_UNAVAILABLE" : "BLOCK_SIGNATURE_MISSING");
      }
    }
  }
  return events.map((event) => ({
    ...event,
    transactionIndex: orderBySignature.get(event.signature) ?? null,
    transactionOrderStatus: statusBySignature.get(event.signature) ?? "TRANSACTION_ORDER_UNAVAILABLE",
  }));
}

function mergeEvidence(pool, evidence) {
  if (!evidence) return { ...pool, universeStatus: null, currentPrice: null, currentTick: null, tickSpacing: null, activeLiquidity: null, replayEvidence: null, shadowReplay: null, executionCosts: null, feeConfigVerified: false, evidence: null };
  const state = evidence.poolState ?? {};
  const freshness = evidence.dataFreshness?.state === "FRESH"
    ? evidence.dataFreshness
    : snapshotFreshness(evidence.updatedAt, 30 * 60_000);
  const activeIndexed = evidence.activeIndexed === true && freshness.state === "FRESH";
  return {
    ...pool,
    universeStatus: activeIndexed ? "ACTIVE_INDEXED" : "NOT_ACTIVE",
    currentPrice: finite(state.currentPrice),
    currentTick: finite(state.tickCurrent),
    tickSpacing: finite(state.tickSpacing),
    activeLiquidity: finite(state.liquidityNumber),
    feeRate: finite(state.feeRate),
    feeTier: finite(state.feeRate),
    feeConfigVerified: evidence.feeConfigVerified === true,
    replayEvidence: evidence.replayEvidence ?? null,
    shadowReplay: evidence.shadowReplay ?? null,
    executionCosts: evidence.executionCosts ?? null,
    evidence: { ...evidence, dataFreshness: freshness, activeIndexed },
  };
}

function stage1Eligible(pool, config) {
  return pool.poolType === "CLMM"
    && pool.rwaIdentityVerified === true
    && pool.usdcIdentityVerified === true
    && pool.assetDecimals !== null
    && pool.quoteDecimals !== null
    && pool.tvl >= config.tvlEnterThreshold
    && pool.feeTier !== null;
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function buildExecutionCostEvidence(priorityFeeResult, config) {
  const priorityRows = Array.isArray(priorityFeeResult?.result) ? priorityFeeResult.result : [];
  const priorityFees = priorityRows.map((row) => finite(row?.prioritizationFee)).filter((value) => value !== null);
  const priorityFeeMicroLamports = percentile(priorityFees, 0.95);
  const solPriceUsd = finite(config.execution?.solPriceUsd);
  const baseFeeLamports = finite(config.execution?.baseFeeLamportsPerSignature);
  if (priorityFeeMicroLamports === null || solPriceUsd === null || solPriceUsd <= 0 || baseFeeLamports === null || baseFeeLamports < 0) {
    return {
      quality: "UNAVAILABLE",
      simulation: "NOT_BUILT_AUTO_EXECUTION_OFF",
      source: "getRecentPrioritizationFees",
      priorityFeeMicroLamports,
      solPriceUsd,
      baseFeeLamports,
      blockers: [priorityFeeMicroLamports === null ? "PRIORITY_FEE_UNAVAILABLE" : null, solPriceUsd === null ? "SOL_PRICE_UNAVAILABLE" : null].filter(Boolean),
    };
  }
  const actions = {};
  for (const [action, signatureCount] of Object.entries(config.execution.estimatedSignaturesByAction ?? {})) {
    const computeUnits = action === "MOVE_BOTH" ? 500_000 : action === "OPEN" ? 400_000 : action === "MOVE_CORE" ? 300_000 : 200_000;
    const priorityLamportsPerTx = priorityFeeMicroLamports * computeUnits / 1_000_000;
    const lamports = signatureCount * (baseFeeLamports + priorityLamportsPerTx);
    actions[action] = {
      signatureCount,
      computeUnits,
      baseFeeLamports: signatureCount * baseFeeLamports,
      priorityFeeLamports: signatureCount * priorityLamportsPerTx,
      totalLamports: lamports,
      totalUsd: lamports / 1_000_000_000 * solPriceUsd,
      quality: "ESTIMATED",
    };
  }
  const moveCore = actions.MOVE_CORE?.totalUsd ?? null;
  return {
    quality: "ESTIMATED",
    simulation: "NOT_BUILT_AUTO_EXECUTION_OFF",
    source: "Solana getRecentPrioritizationFees + configured SOL/USD reference",
    priorityFeeMicroLamports,
    solPriceUsd,
    baseFeeLamports,
    actions,
    totalRebalanceCost: moveCore,
    safetyMargin: moveCore === null ? null : moveCore * 0.25,
    blockers: [],
  };
}

async function fetchOfficialSolPrice(config) {
  if (finite(config.execution?.solPriceUsd) !== null) return config.execution.solPriceUsd;
  const url = "https://api-v3.raydium.io/mint/price?mints=So11111111111111111111111111111111111111112";
  try {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) return null;
    const payload = await response.json();
    const value = finite(Number(payload?.data?.So11111111111111111111111111111111111111112));
    return value !== null && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export async function collectProductionEvidence(pools, config) {
  const store = await new EvidenceStore(config.evidence.cacheDir).open();
  const client = new RpcClient(config.rpcUrls, config.evidence, store);
  const priorityFeeResult = await client.request("getRecentPrioritizationFees", [], { cacheKey: "priority-fees:recent", cacheTtlMs: 30_000 });
  const solPriceUsd = await fetchOfficialSolPrice(config);
  const executionCostEvidence = buildExecutionCostEvidence(priorityFeeResult, {
    ...config,
    execution: { ...config.execution, solPriceUsd },
  });
  const candidates = pools.filter((pool) => stage1Eligible(pool, config)).sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0));
  const cached = new Map(candidates.map((pool) => [pool.poolAddress, store.readPoolEvidence(pool.poolAddress)]));
  const selected = candidates
    .sort((a, b) => {
      const aEvidence = cached.get(a.poolAddress);
      const bEvidence = cached.get(b.poolAddress);
      const aActive = aEvidence?.activeIndexed === true ? 0 : 1;
      const bActive = bEvidence?.activeIndexed === true ? 0 : 1;
      return aActive - bActive || (b.tvl ?? 0) - (a.tvl ?? 0);
    })
    .slice(0, config.evidence.maxPoolsPerBuild);
  const evidence = new Map();
  const collected = await Promise.all(selected.map((pool) => collectPoolEvidence(client, store, pool, config, Math.floor(Date.now() / 1_000), executionCostEvidence)));
  for (const [index, item] of collected.entries()) evidence.set(selected[index].poolAddress, item);
  for (const pool of candidates) {
    if (!evidence.has(pool.poolAddress) && cached.get(pool.poolAddress)) evidence.set(pool.poolAddress, cached.get(pool.poolAddress));
  }
  const enrichedPools = pools.map((pool) => mergeEvidence(pool, evidence.get(pool.poolAddress)));
  const activeIndexedCount = enrichedPools.filter((pool) => pool.universeStatus === "ACTIVE_INDEXED").length;
  const freshCount = enrichedPools.filter((pool) => pool.evidence?.dataFreshness?.state === "FRESH").length;
  const latency = client.metrics.latencyMs;
  const evidenceSummary = {
    stage1CandidateCount: candidates.length,
    stage1ProcessedThisBuild: selected.length,
    activeIndexedCount,
    freshCount,
    rpc: {
      requests: client.metrics.requests,
      rateLimited: client.metrics.rateLimited,
      failures: client.metrics.failures,
      methods: client.metrics.methods,
      averageLatencyMs: latency.length ? latency.reduce((sum, item) => sum + item, 0) / latency.length : null,
      p95LatencyMs: percentile(latency, 0.95),
      endpoints: client.metrics.endpoints,
    },
    source: "Raydium API metadata + Solana RPC PoolState/TickArray + SQLite checkpoint replay",
    status: activeIndexedCount > 0 ? "PARTIAL" : "UNAVAILABLE",
  };
  store.close();
  return { pools: enrichedPools, evidenceSummary };
}

export function snapshotHash(snapshot) {
  const copy = { ...snapshot };
  delete copy.snapshotHash;
  return createHash("sha256").update(json(copy)).digest("hex");
}

export function snapshotFreshness(generatedAt, slaMs) {
  const timestamp = Date.parse(generatedAt);
  const ageMs = Number.isFinite(timestamp) ? Math.max(0, Date.now() - timestamp) : null;
  return {
    state: ageMs !== null && ageMs <= slaMs ? "FRESH" : "STALE",
    ageMs,
    slaMs,
  };
}
