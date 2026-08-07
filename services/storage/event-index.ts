import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { WINDOW_KEYS, type BackfillFailure, type BackfillJobSnapshot, type BackfillPoolCursor, type EventWindowCoverage, type MinuteBucket, type PositionSnapshot, type RawTransactionRecord, type RpcFailureCategory, type SwapErrorCategory, type SwapEventRecord, type TransactionClassification, type WindowKey } from "@/packages/models/src";

type SqliteModule = typeof import("node:sqlite");
type DatabaseHandle = InstanceType<SqliteModule["DatabaseSync"]>;

function loadSqlite(): SqliteModule {
  const builtinModuleLoader = (process as NodeJS.Process & {
    getBuiltinModule?: (moduleId: string) => unknown;
  }).getBuiltinModule;
  const sqlite = builtinModuleLoader?.("node:sqlite") as SqliteModule | undefined;
  if (!sqlite?.DatabaseSync) throw new Error("当前 Node 运行时不支持 node:sqlite");
  return sqlite;
}

type PersistResult = {
  persistedEventCount: number;
  totalEventCount: number;
  latencyMs: number | null;
  error: string | null;
};

export type RpcAccountCacheEntry = {
  address: string;
  kind: "pool" | "mint" | "vault";
  payload: unknown;
  fetchedAt: string;
  expiresAt: string;
};

export type CachedRpcTransaction = {
  signature: string;
  slot: number | null;
  blockTime: number | null;
  payload: unknown | null;
  status: "SUCCESS" | "FAILED";
  error: string | null;
  fetchedAt: string;
  providerUrl: string | null;
};

export type RawTransactionCacheEntry = RawTransactionRecord;

export type BackfillCheckpoint = {
  checkpointKey: string;
  windowKey: string;
  programId: string;
  beforeSignature: string | null;
  page: number;
  signaturesDiscovered: number;
  transactionsFetched: number;
  status: "RUNNING" | "COMPLETE" | "FAILED";
  poolTier: number;
  updatedAt: string;
};

export type BackfillSignature = {
  signature: string;
  slot: number | null;
  blockTime: number | null;
  err: boolean;
};

export type StorageMetricsSnapshot = {
  startedAt: string;
  writeOperations: number;
  rowsWritten: number;
  writesByTable: Record<string, number>;
};

let database: DatabaseHandle | null = null;
let databaseError: string | null = null;
const storageMetrics: StorageMetricsSnapshot = {
  startedAt: new Date().toISOString(),
  writeOperations: 0,
  rowsWritten: 0,
  writesByTable: {},
};

function noteStorageWrites(table: string, rows: number): void {
  if (rows <= 0) return;
  storageMetrics.writeOperations += 1;
  storageMetrics.rowsWritten += rows;
  storageMetrics.writesByTable[table] = (storageMetrics.writesByTable[table] ?? 0) + rows;
}

function eventDatabasePath(): string {
  if (process.env.LP_EVENT_DB_PATH) return process.env.LP_EVENT_DB_PATH;
  const localPath = path.join(process.cwd(), ".local-data", "lp-events.sqlite");
  return existsSync(localPath) ? localPath : path.join(process.cwd(), "db", "lp-events.sqlite");
}

function applyImmutableMigrations(db: DatabaseHandle): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_id TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const migrationRoot = process.env.LP_MIGRATIONS_DIR ?? path.join(process.cwd(), "migrations");
  if (!existsSync(migrationRoot)) return;
  const files = readdirSync(migrationRoot).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
  for (const file of files) {
    const migrationId = file;
    const sql = readFileSync(path.join(migrationRoot, file), "utf8");
    const sha256 = createHash("sha256").update(sql).digest("hex");
    const applied = db.prepare("SELECT sha256 FROM schema_migrations WHERE migration_id = ?").get(migrationId) as { sha256?: unknown } | undefined;
    if (applied && applied.sha256 !== sha256) throw new Error(`迁移校验和不匹配：${migrationId}`);
    if (applied) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (migration_id, sha256, applied_at) VALUES (?, ?, ?)").run(migrationId, sha256, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* 保留原始迁移错误 */ }
      throw error;
    }
  }
}

export function getStorageMetricsSnapshot(): StorageMetricsSnapshot {
  return {
    ...storageMetrics,
    writesByTable: { ...storageMetrics.writesByTable },
  };
}

function getDatabase(): DatabaseHandle | null {
  if (database || databaseError) return database;
  try {
    const databasePath = eventDatabasePath();
    mkdirSync(path.dirname(databasePath), { recursive: true });
    database = new (loadSqlite().DatabaseSync)(databasePath);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA wal_autocheckpoint = 1000;
      CREATE TABLE IF NOT EXISTS swap_events (
        signature TEXT PRIMARY KEY,
        pool_id TEXT NOT NULL,
        slot INTEGER NOT NULL,
        block_time TEXT NOT NULL,
        volume REAL NOT NULL,
        fee REAL,
        parsed_at TEXT NOT NULL,
        persisted_at TEXT NOT NULL,
        parse_latency_ms INTEGER,
        persistence_latency_ms INTEGER,
        source TEXT NOT NULL,
        program_version TEXT,
        input_mint TEXT,
        output_mint TEXT,
        actual_amount_in_atomic TEXT,
        actual_amount_out_atomic TEXT,
        base_fee_rate REAL,
        dynamic_fee_rate REAL,
        effective_fee_rate REAL,
        gross_trade_fee_atomic TEXT,
        protocol_fee_atomic TEXT,
        fund_fee_atomic TEXT,
        lp_fee_atomic TEXT,
        token2022_transfer_fee_atomic TEXT,
        price_usd REAL,
        fee_usd REAL
      );
      CREATE INDEX IF NOT EXISTS swap_events_pool_time ON swap_events (pool_id, block_time);
      CREATE TABLE IF NOT EXISTS pool_scans (
        pool_id TEXT PRIMARY KEY,
        scanned_at TEXT NOT NULL,
        source TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS position_snapshots (
        position_nft_mint TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        owner TEXT NOT NULL,
        pool_address TEXT NOT NULL,
        position_value_usd REAL,
        uncollected_fee_usd REAL,
        reward_usd REAL,
        current_tick INTEGER,
        in_range INTEGER,
        active_seconds INTEGER NOT NULL,
        token0_amount TEXT,
        token1_amount TEXT,
        hold_benchmark_value REAL,
        impermanent_loss REAL,
        realized_fee_return REAL,
        actual_fee_return REAL,
        in_range_hourly_fee_rate REAL,
        relative_hold_net_return REAL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (position_nft_mint, observed_at)
      );
      CREATE INDEX IF NOT EXISTS position_snapshots_time ON position_snapshots (position_nft_mint, observed_at);
      CREATE TABLE IF NOT EXISTS window_coverage (
        pool_id TEXT NOT NULL,
        window_key TEXT NOT NULL,
        window_start TEXT,
        window_end TEXT,
        start_slot INTEGER,
        end_slot INTEGER,
        expected_slot_start INTEGER,
        expected_slot_end INTEGER,
        event_count INTEGER NOT NULL,
        pool_count INTEGER NOT NULL,
        first_slot INTEGER,
        last_slot INTEGER,
        first_event_at TEXT,
        last_event_at TEXT,
        completeness REAL,
        persisted INTEGER NOT NULL,
        source TEXT NOT NULL,
        signatures_discovered INTEGER NOT NULL,
        transactions_fetched INTEGER NOT NULL,
        transactions_successful INTEGER NOT NULL,
        transactions_failed INTEGER NOT NULL,
        swaps_parsed INTEGER NOT NULL,
        swaps_rejected INTEGER NOT NULL,
        duplicates_removed INTEGER NOT NULL,
        unknown_instructions INTEGER,
        gap_slots INTEGER,
        coverage_ratio REAL,
        first_event_time TEXT,
        last_event_time TEXT,
        backfill_status TEXT NOT NULL,
        expected_bucket_count INTEGER,
        metrics_bucket_count INTEGER,
        unresolved_retryable_transactions INTEGER,
        gap_count INTEGER,
        oldest_covered_block_time TEXT,
        observed_at TEXT NOT NULL,
        PRIMARY KEY (pool_id, window_key)
      );
      CREATE INDEX IF NOT EXISTS window_coverage_status ON window_coverage (window_key, backfill_status, observed_at);
      CREATE TABLE IF NOT EXISTS swap_events_v2 (
        event_key TEXT PRIMARY KEY,
        signature TEXT NOT NULL,
        instruction_index INTEGER NOT NULL,
        trader TEXT,
        pool_id TEXT NOT NULL,
        slot INTEGER NOT NULL,
        block_time TEXT NOT NULL,
        received_at TEXT,
        volume REAL NOT NULL,
        fee REAL,
        parsed_at TEXT NOT NULL,
        persisted_at TEXT NOT NULL,
        parse_latency_ms INTEGER,
        persistence_latency_ms INTEGER,
        source TEXT NOT NULL,
        program_version TEXT,
        input_mint TEXT,
        output_mint TEXT,
        actual_amount_in_atomic TEXT,
        actual_amount_out_atomic TEXT,
        base_fee_rate REAL,
        dynamic_fee_rate REAL,
        effective_fee_rate REAL,
        gross_trade_fee_atomic TEXT,
        protocol_fee_atomic TEXT,
        fund_fee_atomic TEXT,
        lp_fee_atomic TEXT,
        token2022_transfer_fee_atomic TEXT,
        price_usd REAL,
        fee_usd REAL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS swap_events_v2_signature_instruction_pool ON swap_events_v2 (signature, instruction_index, pool_id);
      CREATE INDEX IF NOT EXISTS swap_events_v2_pool_time ON swap_events_v2 (pool_id, block_time);
      CREATE TABLE IF NOT EXISTS minute_buckets (
        pool_id TEXT NOT NULL,
        bucket_start TEXT NOT NULL,
        volume_usd REAL NOT NULL,
        gross_fee_usd REAL,
        lp_fee_usd REAL,
        swap_count INTEGER NOT NULL,
        buy_volume_usd REAL NOT NULL,
        sell_volume_usd REAL NOT NULL,
        unique_wallet_count INTEGER,
        tvl_start REAL,
        tvl_end REAL,
        active_tvl REAL,
        fee_density REAL,
        liquidity_velocity REAL,
        coverage_ratio REAL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        as_of TEXT NOT NULL,
        PRIMARY KEY (pool_id, bucket_start)
      );
      CREATE INDEX IF NOT EXISTS minute_buckets_pool_time ON minute_buckets (pool_id, bucket_start);
      CREATE TABLE IF NOT EXISTS normalized_swaps (
        event_key TEXT PRIMARY KEY,
        signature TEXT NOT NULL,
        instruction_index INTEGER NOT NULL,
        pool_address TEXT NOT NULL,
        program_type TEXT NOT NULL,
        trader TEXT,
        slot INTEGER NOT NULL,
        block_time TEXT NOT NULL,
        input_mint TEXT,
        output_mint TEXT,
        amount_in TEXT,
        amount_out TEXT,
        volume_usd REAL NOT NULL,
        gross_fee_usd REAL,
        lp_fee_usd REAL,
        fee REAL,
        base_fee_rate REAL,
        dynamic_fee_rate REAL,
        effective_fee_rate REAL,
        gross_trade_fee_atomic TEXT,
        protocol_fee_atomic TEXT,
        fund_fee_atomic TEXT,
        lp_fee_atomic TEXT,
        token2022_transfer_fee_atomic TEXT,
        price_usd REAL,
        source TEXT NOT NULL,
        parse_version TEXT NOT NULL,
        parsed_at TEXT NOT NULL,
        inserted_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS normalized_swaps_signature_instruction_pool ON normalized_swaps (signature, instruction_index, pool_address);
      CREATE INDEX IF NOT EXISTS normalized_swaps_pool_time ON normalized_swaps (pool_address, block_time);
      CREATE TABLE IF NOT EXISTS pool_metrics_1m (
        pool_id TEXT NOT NULL,
        bucket_start TEXT NOT NULL,
        volume_usd REAL NOT NULL,
        gross_fee_usd REAL,
        lp_fee_usd REAL,
        swap_count INTEGER NOT NULL,
        buy_volume_usd REAL NOT NULL,
        sell_volume_usd REAL NOT NULL,
        unique_wallet_count INTEGER,
        tvl_start REAL,
        tvl_end REAL,
        active_tvl REAL,
        fee_density REAL,
        liquidity_velocity REAL,
        coverage_ratio REAL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        as_of TEXT NOT NULL,
        PRIMARY KEY (pool_id, bucket_start)
      );
      CREATE INDEX IF NOT EXISTS pool_metrics_1m_pool_time ON pool_metrics_1m (pool_id, bucket_start);
      CREATE TABLE IF NOT EXISTS backfill_jobs (
        job_id TEXT PRIMARY KEY,
        target_window TEXT NOT NULL,
        target_block_time TEXT NOT NULL,
        started_at TEXT NOT NULL,
        last_progress_at TEXT,
        status TEXT NOT NULL,
        target_pool_count INTEGER NOT NULL,
        completed_pool_count INTEGER NOT NULL,
        oldest_covered_at TEXT,
        signatures_discovered INTEGER NOT NULL,
        transactions_fetched INTEGER NOT NULL,
        transactions_parsed INTEGER NOT NULL,
        transactions_failed INTEGER NOT NULL,
        unknown_instructions INTEGER NOT NULL,
        requests_last_5m INTEGER NOT NULL,
        successful_transactions_last_5m INTEGER NOT NULL,
        rpc429_last_5m INTEGER NOT NULL,
        current_cursor_time TEXT,
        estimated_finish_at TEXT,
        eta_ms INTEGER,
        restart_count INTEGER NOT NULL,
        blocked_reason TEXT,
        progress_history_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS backfill_pool_cursors (
        job_id TEXT NOT NULL,
        pool_address TEXT NOT NULL,
        oldest_fetched_signature TEXT,
        oldest_fetched_block_time TEXT,
        oldest_fetched_slot INTEGER,
        target_block_time TEXT NOT NULL,
        signatures_discovered INTEGER NOT NULL,
        transactions_fetched INTEGER NOT NULL,
        transactions_parsed INTEGER NOT NULL,
        transactions_failed INTEGER NOT NULL,
        unknown_instructions INTEGER NOT NULL,
        last_progress_at TEXT,
        retry_count INTEGER NOT NULL,
        status TEXT NOT NULL,
        PRIMARY KEY (job_id, pool_address)
      );
      CREATE INDEX IF NOT EXISTS backfill_pool_cursors_status ON backfill_pool_cursors (job_id, status, last_progress_at);
      CREATE TABLE IF NOT EXISTS backfill_failures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        pool_address TEXT NOT NULL,
        signature TEXT,
        method TEXT NOT NULL,
        error TEXT NOT NULL,
        retry_count INTEGER NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS backfill_failures_job ON backfill_failures (job_id, last_seen_at);
      CREATE TABLE IF NOT EXISTS indexer_state (
        state_key TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS official_reconciliation (
        pool_id TEXT PRIMARY KEY,
        official_as_of TEXT,
        local_as_of TEXT,
        official_tvl REAL,
        local_tvl REAL,
        official_volume_24h REAL,
        local_volume_24h REAL,
        official_fee_24h REAL,
        local_fee_24h REAL,
        volume_difference_pct REAL,
        fee_difference_pct REAL,
        status TEXT NOT NULL,
        checked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rpc_account_cache (
        address TEXT NOT NULL,
        cache_kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (address, cache_kind)
      );
      CREATE INDEX IF NOT EXISTS rpc_account_cache_expiry ON rpc_account_cache (expires_at);
      CREATE TABLE IF NOT EXISTS rpc_transaction_cache (
        signature TEXT PRIMARY KEY,
        slot INTEGER,
        block_time INTEGER,
        payload_json TEXT,
        status TEXT NOT NULL,
        error TEXT,
        fetched_at TEXT NOT NULL,
        provider_url TEXT
      );
      CREATE TABLE IF NOT EXISTS raw_transactions (
        signature TEXT PRIMARY KEY,
        slot INTEGER,
        block_time INTEGER,
        transaction_json TEXT,
        fetch_status TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        rpc_endpoint TEXT,
        sha256 TEXT,
        error_category TEXT,
        error_code TEXT,
        error_message TEXT,
        retryable INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_attempt_at TEXT NOT NULL,
        parser_version TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS raw_transactions_status ON raw_transactions (fetch_status, last_attempt_at);
      CREATE TABLE IF NOT EXISTS transaction_classifications (
        classification_key TEXT PRIMARY KEY,
        signature TEXT NOT NULL,
        slot INTEGER,
        block_time INTEGER,
        pool_address TEXT,
        program_id TEXT,
        transaction_version TEXT,
        error_category TEXT NOT NULL,
        error_code TEXT NOT NULL,
        error_message TEXT NOT NULL,
        retryable INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_attempt_at TEXT NOT NULL,
        raw_transaction_path TEXT,
        parser_version TEXT NOT NULL,
        instruction_index INTEGER,
        discriminator TEXT,
        account_count INTEGER
      );
      CREATE INDEX IF NOT EXISTS transaction_classifications_signature ON transaction_classifications (signature, pool_address);
      CREATE INDEX IF NOT EXISTS transaction_classifications_category ON transaction_classifications (error_category, last_attempt_at);
      CREATE TABLE IF NOT EXISTS backfill_checkpoints (
        checkpoint_key TEXT PRIMARY KEY,
        window_key TEXT NOT NULL,
        program_id TEXT NOT NULL,
        before_signature TEXT,
        page INTEGER NOT NULL,
        signatures_discovered INTEGER NOT NULL,
        transactions_fetched INTEGER NOT NULL,
        status TEXT NOT NULL,
        pool_tier INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS backfill_signatures (
        checkpoint_key TEXT NOT NULL,
        signature TEXT NOT NULL,
        slot INTEGER,
        block_time INTEGER,
        has_error INTEGER NOT NULL,
        PRIMARY KEY (checkpoint_key, signature)
      );
      CREATE INDEX IF NOT EXISTS backfill_signatures_time ON backfill_signatures (checkpoint_key, block_time);
    `);
    applyImmutableMigrations(database);
    for (const column of [
      "program_version TEXT",
      "trader TEXT",
      "input_mint TEXT",
      "output_mint TEXT",
      "actual_amount_in_atomic TEXT",
      "actual_amount_out_atomic TEXT",
      "base_fee_rate REAL",
      "dynamic_fee_rate REAL",
      "effective_fee_rate REAL",
      "gross_trade_fee_atomic TEXT",
      "protocol_fee_atomic TEXT",
      "fund_fee_atomic TEXT",
      "lp_fee_atomic TEXT",
      "token2022_transfer_fee_atomic TEXT",
      "price_usd REAL",
      "fee_usd REAL",
    ]) {
      try {
        database.exec(`ALTER TABLE swap_events ADD COLUMN ${column}`);
      } catch {
        // 已存在的列无需迁移。
      }
    }
    for (const column of [
      "expected_bucket_count INTEGER",
      "metrics_bucket_count INTEGER",
      "unresolved_retryable_transactions INTEGER",
      "gap_count INTEGER",
      "oldest_covered_block_time TEXT",
    ]) {
      try {
        database.exec(`ALTER TABLE window_coverage ADD COLUMN ${column}`);
      } catch {
        // 已存在的窗口证据列无需迁移。
      }
    }
    try {
      database.exec("ALTER TABLE swap_events_v2 ADD COLUMN trader TEXT");
    } catch {
      // 已存在的 v2 列无需迁移。
    }
    database.exec(`
      INSERT OR IGNORE INTO swap_events_v2
      (event_key, signature, instruction_index, trader, pool_id, slot, block_time, received_at, volume, fee, parsed_at, persisted_at, parse_latency_ms, persistence_latency_ms, source, program_version, input_mint, output_mint, actual_amount_in_atomic, actual_amount_out_atomic, base_fee_rate, dynamic_fee_rate, effective_fee_rate, gross_trade_fee_atomic, protocol_fee_atomic, fund_fee_atomic, lp_fee_atomic, token2022_transfer_fee_atomic, price_usd, fee_usd)
      SELECT signature || ':0:' || pool_id, signature, 0, NULL, pool_id, slot, block_time, NULL, volume, fee, parsed_at, persisted_at, parse_latency_ms, persistence_latency_ms, source, program_version, input_mint, output_mint, actual_amount_in_atomic, actual_amount_out_atomic, base_fee_rate, dynamic_fee_rate, effective_fee_rate, gross_trade_fee_atomic, protocol_fee_atomic, fund_fee_atomic, lp_fee_atomic, token2022_transfer_fee_atomic, price_usd, fee_usd
      FROM swap_events;
    `);
    database.exec(`
      INSERT OR IGNORE INTO normalized_swaps
      (event_key, signature, instruction_index, pool_address, program_type, trader, slot, block_time, input_mint, output_mint, amount_in, amount_out, volume_usd, gross_fee_usd, lp_fee_usd, fee, base_fee_rate, dynamic_fee_rate, effective_fee_rate, gross_trade_fee_atomic, protocol_fee_atomic, fund_fee_atomic, lp_fee_atomic, token2022_transfer_fee_atomic, price_usd, source, parse_version, parsed_at, inserted_at)
      SELECT event_key, signature, instruction_index, pool_id, COALESCE(program_version, 'unknown'), trader, slot, block_time, input_mint, output_mint, actual_amount_in_atomic, actual_amount_out_atomic, volume, fee_usd, fee_usd, fee, base_fee_rate, dynamic_fee_rate, effective_fee_rate, gross_trade_fee_atomic, protocol_fee_atomic, fund_fee_atomic, lp_fee_atomic, token2022_transfer_fee_atomic, price_usd, source, 'legacy-migration-v1', parsed_at, persisted_at
      FROM swap_events_v2;
      INSERT OR IGNORE INTO pool_metrics_1m
      (pool_id, bucket_start, volume_usd, gross_fee_usd, lp_fee_usd, swap_count, buy_volume_usd, sell_volume_usd, unique_wallet_count, tvl_start, tvl_end, active_tvl, fee_density, liquidity_velocity, coverage_ratio, status, source, as_of)
      SELECT pool_id, bucket_start, volume_usd, gross_fee_usd, lp_fee_usd, swap_count, buy_volume_usd, sell_volume_usd, unique_wallet_count, tvl_start, tvl_end, active_tvl, fee_density, liquidity_velocity, coverage_ratio, status, source, as_of
      FROM minute_buckets;
    `);
    return database;
  } catch (error) {
    databaseError = error instanceof Error ? error.message : "SQLite 初始化失败";
    return null;
  }
}

export function getEventStoreError(): string | null {
  getDatabase();
  return databaseError;
}

/**
 * 标准化事实表是唯一的交易语义来源；swap_events_v2 只保留为历史兼容镜像。
 * 唯一键由 signature + instruction_index + pool_address 组成，WebSocket 与历史回补共用。
 */
export function persistNormalizedSwaps(events: SwapEventRecord[], parseVersion = "normalized-swap-v1"): { rows: number; error: string | null } {
  const db = getDatabase();
  if (!db || events.length === 0) return { rows: 0, error: db ? null : databaseError ?? "SQLite 不可用" };
  try {
    const insert = db.prepare(`
      INSERT OR IGNORE INTO normalized_swaps
      (event_key, signature, instruction_index, pool_address, program_type, trader, slot, block_time, input_mint, output_mint, amount_in, amount_out, volume_usd, gross_fee_usd, lp_fee_usd, fee, base_fee_rate, dynamic_fee_rate, effective_fee_rate, gross_trade_fee_atomic, protocol_fee_atomic, fund_fee_atomic, lp_fee_atomic, token2022_transfer_fee_atomic, price_usd, source, parse_version, parsed_at, inserted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertedAt = new Date().toISOString();
    let rows = 0;
    db.exec("BEGIN");
    for (const event of events) {
      const result = insert.run(
        `${event.signature}:${event.instructionIndex ?? 0}:${event.poolId}`,
        event.signature,
        event.instructionIndex ?? 0,
        event.poolId,
        event.programVersion ?? "unknown",
        event.trader ?? null,
        event.slot,
        event.blockTime,
        event.inputMint,
        event.outputMint,
        event.actualAmountInAtomic,
        event.actualAmountOutAtomic,
        event.volume,
        event.feeUsd,
        event.feeUsd,
        event.fee,
        event.baseFeeRate,
        event.dynamicFeeRate,
        event.effectiveFeeRate,
        event.grossTradeFeeAtomic,
        event.protocolFeeAtomic,
        event.fundFeeAtomic,
        event.lpFeeAtomic,
        event.token2022TransferFeeAtomic,
        event.priceUsd,
        event.source,
        parseVersion,
        event.parsedAt,
        insertedAt,
      );
      rows += Number(result.changes ?? 0);
    }
    db.exec("COMMIT");
    noteStorageWrites("normalized_swaps", rows);
    return { rows, error: null };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* 保留原始错误 */ }
    return { rows: 0, error: error instanceof Error ? error.message : "标准化 Swap 落库失败" };
  }
}

export function persistSwapEvents(events: SwapEventRecord[], scannedPoolIds: string[]): PersistResult {
  const startedAt = Date.now();
  const db = getDatabase();
  if (!db) return { persistedEventCount: 0, totalEventCount: 0, latencyMs: null, error: databaseError ?? "SQLite 不可用" };
  const persistedAt = new Date().toISOString();
  let persistedEventCount = 0;
  try {
    db.exec("BEGIN");
    const insert = db.prepare(`
      INSERT OR IGNORE INTO swap_events_v2
      (event_key, signature, instruction_index, trader, pool_id, slot, block_time, received_at, volume, fee, parsed_at, persisted_at, parse_latency_ms, persistence_latency_ms, source, program_version, input_mint, output_mint, actual_amount_in_atomic, actual_amount_out_atomic, base_fee_rate, dynamic_fee_rate, effective_fee_rate, gross_trade_fee_atomic, protocol_fee_atomic, fund_fee_atomic, lp_fee_atomic, token2022_transfer_fee_atomic, price_usd, fee_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const event of events) {
      const result = insert.run(
        `${event.signature}:${event.instructionIndex ?? 0}:${event.poolId}`,
        event.signature,
        event.instructionIndex ?? 0,
        event.trader ?? null,
        event.poolId,
        event.slot,
        event.blockTime,
        event.receivedAt ?? event.parsedAt,
        event.volume,
        event.fee,
        event.parsedAt,
        persistedAt,
        event.parseLatencyMs,
        null,
        event.source,
        event.programVersion,
        event.inputMint,
        event.outputMint,
        event.actualAmountInAtomic,
        event.actualAmountOutAtomic,
        event.baseFeeRate,
        event.dynamicFeeRate,
        event.effectiveFeeRate,
        event.grossTradeFeeAtomic,
        event.protocolFeeAtomic,
        event.fundFeeAtomic,
        event.lpFeeAtomic,
        event.token2022TransferFeeAtomic,
        event.priceUsd,
        event.feeUsd,
      );
      if (Number(result.changes ?? 0) > 0) persistedEventCount += 1;
    }
    const scan = db.prepare("INSERT OR REPLACE INTO pool_scans (pool_id, scanned_at, source) VALUES (?, ?, ?)");
    for (const poolId of scannedPoolIds) scan.run(poolId, persistedAt, "Solana RPC 回补");
    db.exec("COMMIT");
    const persistenceLatencyMs = Date.now() - startedAt;
    db.prepare("UPDATE swap_events_v2 SET persistence_latency_ms = ? WHERE persisted_at = ?").run(persistenceLatencyMs, persistedAt);
    noteStorageWrites("swap_events_v2", persistedEventCount);
    noteStorageWrites("pool_scans", scannedPoolIds.length);
    const normalized = persistNormalizedSwaps(events);
    return { persistedEventCount, totalEventCount: events.length, latencyMs: persistenceLatencyMs, error: normalized.error };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 回滚失败不应掩盖原始存储错误。
    }
    return { persistedEventCount, totalEventCount: events.length, latencyMs: Date.now() - startedAt, error: error instanceof Error ? error.message : "Swap 事件落库失败" };
  }
}

export function readRecentSwapEvents(poolIds: string[], since: Date): SwapEventRecord[] {
  const db = getDatabase();
  if (!db || poolIds.length === 0) return [];
  try {
    const placeholders = poolIds.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT signature, instruction_index, trader, pool_address AS pool_id, slot, block_time, inserted_at AS received_at, volume_usd AS volume, fee, parsed_at, inserted_at AS persisted_at, NULL AS parse_latency_ms, NULL AS persistence_latency_ms, source, program_type AS program_version, input_mint, output_mint, amount_in AS actual_amount_in_atomic, amount_out AS actual_amount_out_atomic, base_fee_rate, dynamic_fee_rate, effective_fee_rate, gross_trade_fee_atomic, protocol_fee_atomic, fund_fee_atomic, lp_fee_atomic, token2022_transfer_fee_atomic, price_usd, lp_fee_usd AS fee_usd
      FROM normalized_swaps
      WHERE pool_address IN (${placeholders}) AND block_time >= ?
      ORDER BY slot DESC
    `).all(...poolIds, since.toISOString()) as Array<Record<string, unknown>>;
    return rows.flatMap((row) => {
      if (typeof row.signature !== "string" || typeof row.pool_id !== "string" || typeof row.slot !== "number" || typeof row.block_time !== "string" || typeof row.volume !== "number" || typeof row.parsed_at !== "string" || typeof row.persisted_at !== "string" || typeof row.source !== "string") return [];
      return [{
        signature: row.signature,
        instructionIndex: typeof row.instruction_index === "number" ? row.instruction_index : 0,
        trader: typeof row.trader === "string" ? row.trader : null,
        poolId: row.pool_id,
        slot: row.slot,
        blockTime: row.block_time,
        receivedAt: typeof row.received_at === "string" ? row.received_at : row.parsed_at,
        volume: row.volume,
        fee: typeof row.fee === "number" ? row.fee : null,
        parsedAt: row.parsed_at,
        persistedAt: row.persisted_at,
        parseLatencyMs: typeof row.parse_latency_ms === "number" ? row.parse_latency_ms : null,
        persistenceLatencyMs: typeof row.persistence_latency_ms === "number" ? row.persistence_latency_ms : null,
        source: row.source === "websocket" ? "websocket" as const : "rpc-replay" as const,
        programVersion: typeof row.program_version === "string" ? row.program_version : null,
        inputMint: typeof row.input_mint === "string" ? row.input_mint : null,
        outputMint: typeof row.output_mint === "string" ? row.output_mint : null,
        actualAmountInAtomic: typeof row.actual_amount_in_atomic === "string" ? row.actual_amount_in_atomic : null,
        actualAmountOutAtomic: typeof row.actual_amount_out_atomic === "string" ? row.actual_amount_out_atomic : null,
        baseFeeRate: typeof row.base_fee_rate === "number" ? row.base_fee_rate : null,
        dynamicFeeRate: typeof row.dynamic_fee_rate === "number" ? row.dynamic_fee_rate : null,
        effectiveFeeRate: typeof row.effective_fee_rate === "number" ? row.effective_fee_rate : null,
        grossTradeFeeAtomic: typeof row.gross_trade_fee_atomic === "string" ? row.gross_trade_fee_atomic : null,
        protocolFeeAtomic: typeof row.protocol_fee_atomic === "string" ? row.protocol_fee_atomic : null,
        fundFeeAtomic: typeof row.fund_fee_atomic === "string" ? row.fund_fee_atomic : null,
        lpFeeAtomic: typeof row.lp_fee_atomic === "string" ? row.lp_fee_atomic : null,
        token2022TransferFeeAtomic: typeof row.token2022_transfer_fee_atomic === "string" ? row.token2022_transfer_fee_atomic : null,
        priceUsd: typeof row.price_usd === "number" ? row.price_usd : null,
        feeUsd: typeof row.fee_usd === "number" ? row.fee_usd : null,
      }];
    });
  } catch {
    return [];
  }
}

/** 统一事实表读取别名；回补与实时流不得重新读取旧镜像表。 */
export function readNormalizedSwaps(poolIds: string[], since: Date): SwapEventRecord[] {
  return readRecentSwapEvents(poolIds, since);
}

function emptyCoverage(): EventWindowCoverage {
  return {
    eventCount: 0,
    poolCount: 0,
    firstSlot: null,
    lastSlot: null,
    firstEventAt: null,
    lastEventAt: null,
    completeness: null,
    persisted: false,
    source: "尚未回补",
    windowStart: null,
    windowEnd: null,
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
    backfillStatus: "UNAVAILABLE",
  };
}

export function persistWindowCoverage(coverageByPool: Record<string, Partial<Record<WindowKey, EventWindowCoverage>>>): { rows: number; error: string | null } {
  const db = getDatabase();
  if (!db) return { rows: 0, error: databaseError ?? "SQLite 不可用" };
  const observedAt = new Date().toISOString();
  let rows = 0;
  try {
    const insert = db.prepare(`
      INSERT OR REPLACE INTO window_coverage
      (pool_id, window_key, window_start, window_end, start_slot, end_slot, expected_slot_start, expected_slot_end, event_count, pool_count, first_slot, last_slot, first_event_at, last_event_at, completeness, persisted, source, signatures_discovered, transactions_fetched, transactions_successful, transactions_failed, swaps_parsed, swaps_rejected, duplicates_removed, unknown_instructions, gap_slots, coverage_ratio, first_event_time, last_event_time, backfill_status, expected_bucket_count, metrics_bucket_count, unresolved_retryable_transactions, gap_count, oldest_covered_block_time, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [poolId, windows] of Object.entries(coverageByPool)) {
      for (const window of WINDOW_KEYS) {
        const item = windows[window] ?? emptyCoverage();
        const result = insert.run(
          poolId,
          window,
          item.windowStart,
          item.windowEnd,
          item.startSlot,
          item.endSlot,
          item.expectedSlotRange?.start ?? null,
          item.expectedSlotRange?.end ?? null,
          item.eventCount,
          item.poolCount,
          item.firstSlot,
          item.lastSlot,
          item.firstEventAt,
          item.lastEventAt,
          item.completeness,
          item.persisted ? 1 : 0,
          item.source,
          item.signaturesDiscovered,
          item.transactionsFetched,
          item.transactionsSuccessful,
          item.transactionsFailed,
          item.swapsParsed,
          item.swapsRejected,
          item.duplicatesRemoved,
          item.unknownInstructions,
          item.gapSlots,
          item.coverageRatio,
          item.firstEventTime,
          item.lastEventTime,
          item.backfillStatus,
          item.expectedBucketCount ?? null,
          item.metricsBucketCount ?? null,
          item.unresolvedRetryableTransactions ?? null,
          item.gapCount ?? null,
          item.oldestCoveredBlockTime ?? item.oldestCoveredAt ?? null,
          observedAt,
        );
        if (Number(result.changes ?? 0) > 0) rows += 1;
      }
    }
    noteStorageWrites("window_coverage", rows);
    return { rows, error: null };
  } catch (error) {
    return { rows, error: error instanceof Error ? error.message : "窗口覆盖证据落库失败" };
  }
}

export function readWindowCoverage(poolIds: string[]): Record<string, Record<WindowKey, EventWindowCoverage>> {
  const db = getDatabase();
  const result: Record<string, Record<WindowKey, EventWindowCoverage>> = {};
  for (const poolId of poolIds) result[poolId] = Object.fromEntries(WINDOW_KEYS.map((window) => [window, emptyCoverage()])) as Record<WindowKey, EventWindowCoverage>;
  if (!db || poolIds.length === 0) return result;
  try {
    const placeholders = poolIds.map(() => "?").join(",");
    const rows = db.prepare(`SELECT pool_id, window_key, window_start, window_end, start_slot, end_slot, expected_slot_start, expected_slot_end, event_count, pool_count, first_slot, last_slot, first_event_at, last_event_at, completeness, persisted, source, signatures_discovered, transactions_fetched, transactions_successful, transactions_failed, swaps_parsed, swaps_rejected, duplicates_removed, unknown_instructions, gap_slots, coverage_ratio, first_event_time, last_event_time, backfill_status, expected_bucket_count, metrics_bucket_count, unresolved_retryable_transactions, gap_count, oldest_covered_block_time FROM window_coverage WHERE pool_id IN (${placeholders})`).all(...poolIds) as Array<Record<string, unknown>>;
    for (const row of rows) {
      if (typeof row.pool_id !== "string" || typeof row.window_key !== "string" || !WINDOW_KEYS.includes(row.window_key as WindowKey)) continue;
      const asNumber = (value: unknown) => typeof value === "number" ? value : null;
      const asString = (value: unknown) => typeof value === "string" ? value : null;
      const coverage: EventWindowCoverage = {
        eventCount: typeof row.event_count === "number" ? row.event_count : 0,
        poolCount: typeof row.pool_count === "number" ? row.pool_count : 0,
        firstSlot: asNumber(row.first_slot),
        lastSlot: asNumber(row.last_slot),
        firstEventAt: asString(row.first_event_at),
        lastEventAt: asString(row.last_event_at),
        completeness: asNumber(row.completeness),
        persisted: row.persisted === 1,
        source: typeof row.source === "string" ? row.source : "SQLite",
        windowStart: asString(row.window_start),
        windowEnd: asString(row.window_end),
        startSlot: asNumber(row.start_slot),
        endSlot: asNumber(row.end_slot),
        expectedSlotRange: typeof row.expected_slot_start === "number" && typeof row.expected_slot_end === "number" ? { start: row.expected_slot_start, end: row.expected_slot_end } : null,
        signaturesDiscovered: typeof row.signatures_discovered === "number" ? row.signatures_discovered : 0,
        transactionsFetched: typeof row.transactions_fetched === "number" ? row.transactions_fetched : 0,
        transactionsSuccessful: typeof row.transactions_successful === "number" ? row.transactions_successful : 0,
        transactionsFailed: typeof row.transactions_failed === "number" ? row.transactions_failed : 0,
        swapsParsed: typeof row.swaps_parsed === "number" ? row.swaps_parsed : 0,
        swapsRejected: typeof row.swaps_rejected === "number" ? row.swaps_rejected : 0,
        duplicatesRemoved: typeof row.duplicates_removed === "number" ? row.duplicates_removed : 0,
        unknownInstructions: asNumber(row.unknown_instructions),
        gapSlots: asNumber(row.gap_slots),
        coverageRatio: asNumber(row.coverage_ratio),
        firstEventTime: asString(row.first_event_time),
        lastEventTime: asString(row.last_event_time),
        backfillStatus: row.backfill_status === "COMPLETE" || row.backfill_status === "RUNNING" || row.backfill_status === "BACKFILLING" || row.backfill_status === "PARTIAL" || row.backfill_status === "STALLED" || row.backfill_status === "BLOCKED" || row.backfill_status === "LIVE" || row.backfill_status === "INVALID" ? row.backfill_status : "UNAVAILABLE",
        expectedBucketCount: asNumber(row.expected_bucket_count) ?? undefined,
        metricsBucketCount: asNumber(row.metrics_bucket_count) ?? undefined,
        unresolvedRetryableTransactions: asNumber(row.unresolved_retryable_transactions) ?? undefined,
        gapCount: asNumber(row.gap_count),
        oldestCoveredBlockTime: asString(row.oldest_covered_block_time),
      };
      result[row.pool_id][row.window_key as WindowKey] = coverage;
    }
  } catch {
    // 读取失败时保持所有窗口 UNAVAILABLE，避免污染排名。
  }
  return result;
}

export function persistPositionSnapshots(snapshots: PositionSnapshot[]): { persisted: number; skipped: number; error: string | null } {
  const db = getDatabase();
  if (!db) return { persisted: 0, skipped: snapshots.length, error: databaseError ?? "SQLite 不可用" };
  let persisted = 0;
  let skipped = 0;
  try {
    const insert = db.prepare(`
      INSERT OR IGNORE INTO position_snapshots
      (position_nft_mint, observed_at, owner, pool_address, position_value_usd, uncollected_fee_usd, reward_usd, current_tick, in_range, active_seconds, token0_amount, token1_amount, hold_benchmark_value, impermanent_loss, realized_fee_return, actual_fee_return, in_range_hourly_fee_rate, relative_hold_net_return, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const snapshot of snapshots) {
      const latest = db.prepare("SELECT observed_at FROM position_snapshots WHERE position_nft_mint = ? ORDER BY observed_at DESC LIMIT 1").get(snapshot.positionNftMint) as { observed_at?: unknown } | undefined;
      if (typeof latest?.observed_at === "string" && Date.parse(snapshot.observedAt) - Date.parse(latest.observed_at) < 55_000) {
        skipped += 1;
        continue;
      }
      const result = insert.run(
        snapshot.positionNftMint,
        snapshot.observedAt,
        snapshot.owner,
        snapshot.poolAddress,
        snapshot.positionValueUsd,
        snapshot.uncollectedFeeUsd,
        snapshot.rewardUsd,
        snapshot.currentTick,
        snapshot.inRange === null ? null : snapshot.inRange ? 1 : 0,
        snapshot.activeSeconds,
        snapshot.token0Amount,
        snapshot.token1Amount,
        snapshot.holdBenchmarkValue,
        snapshot.impermanentLoss,
        snapshot.realizedFeeReturn,
        snapshot.actualFeeReturn,
        snapshot.inRangeHourlyFeeRate,
        snapshot.relativeHoldNetReturn,
        JSON.stringify(snapshot),
      );
      if (Number(result.changes ?? 0) > 0) persisted += 1;
    }
    noteStorageWrites("position_snapshots", persisted);
    return { persisted, skipped, error: null };
  } catch (error) {
    return { persisted, skipped, error: error instanceof Error ? error.message : "仓位快照落库失败" };
  }
}

export function readPositionBaseline(positionNftMint: string): PositionSnapshot | null {
  const db = getDatabase();
  if (!db) return null;
  try {
    const row = db.prepare("SELECT payload_json FROM position_snapshots WHERE position_nft_mint = ? ORDER BY observed_at ASC LIMIT 1").get(positionNftMint) as { payload_json?: unknown } | undefined;
    if (typeof row?.payload_json !== "string") return null;
    const parsed = JSON.parse(row.payload_json) as PositionSnapshot;
    return parsed && parsed.positionNftMint === positionNftMint ? parsed : null;
  } catch {
    return null;
  }
}

export function readLatestPositionSnapshot(positionNftMint: string): PositionSnapshot | null {
  const db = getDatabase();
  if (!db) return null;
  try {
    const row = db.prepare("SELECT payload_json FROM position_snapshots WHERE position_nft_mint = ? ORDER BY observed_at DESC LIMIT 1").get(positionNftMint) as { payload_json?: unknown } | undefined;
    if (typeof row?.payload_json !== "string") return null;
    const parsed = JSON.parse(row.payload_json) as PositionSnapshot;
    return parsed && parsed.positionNftMint === positionNftMint ? parsed : null;
  } catch {
    return null;
  }
}

export function readLatestPositionSnapshotsForOwner(owner: string): PositionSnapshot[] {
  const db = getDatabase();
  if (!db) return [];
  try {
    const rows = db.prepare("SELECT position_nft_mint, payload_json FROM position_snapshots WHERE owner = ? ORDER BY observed_at DESC").all(owner) as Array<{ position_nft_mint?: unknown; payload_json?: unknown }>;
    const seen = new Set<string>();
    const snapshots: PositionSnapshot[] = [];
    for (const row of rows) {
      if (typeof row.position_nft_mint !== "string" || seen.has(row.position_nft_mint) || typeof row.payload_json !== "string") continue;
      try {
        const parsed = JSON.parse(row.payload_json) as PositionSnapshot;
        if (parsed.positionNftMint !== row.position_nft_mint || parsed.owner !== owner) continue;
        seen.add(row.position_nft_mint);
        snapshots.push(parsed);
      } catch {
        // 忽略损坏的历史仓位快照，不阻塞公开市场。
      }
    }
    return snapshots;
  } catch {
    return [];
  }
}

export function countPositionSnapshots(): number {
  const db = getDatabase();
  if (!db) return 0;
  try {
    const row = db.prepare("SELECT COUNT(*) AS count FROM position_snapshots").get() as { count?: number } | undefined;
    return typeof row?.count === "number" ? row.count : 0;
  } catch {
    return 0;
  }
}

export function countScannedPools(since: Date): number {
  const db = getDatabase();
  if (!db) return 0;
  try {
    const row = db.prepare("SELECT COUNT(*) AS count FROM pool_scans WHERE scanned_at >= ?").get(since.toISOString()) as { count?: number } | undefined;
    return typeof row?.count === "number" ? row.count : 0;
  } catch {
    return 0;
  }
}

export function getScannedPoolIds(since: Date): Set<string> {
  const db = getDatabase();
  if (!db) return new Set();
  try {
    const rows = db.prepare("SELECT pool_id FROM pool_scans WHERE scanned_at >= ?").all(since.toISOString()) as Array<{ pool_id?: unknown }>;
    return new Set(rows.flatMap((row) => typeof row.pool_id === "string" ? [row.pool_id] : []));
  } catch {
    return new Set();
  }
}

export function persistMinuteBuckets(buckets: MinuteBucket[]): { rows: number; error: string | null } {
  const db = getDatabase();
  if (!db) return { rows: 0, error: databaseError ?? "SQLite 不可用" };
  try {
    const insert = db.prepare(`
      INSERT OR REPLACE INTO pool_metrics_1m
      (pool_id, bucket_start, volume_usd, gross_fee_usd, lp_fee_usd, swap_count, buy_volume_usd, sell_volume_usd, unique_wallet_count, tvl_start, tvl_end, active_tvl, fee_density, liquidity_velocity, coverage_ratio, status, source, as_of)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const bucket of buckets) {
      insert.run(bucket.poolId, bucket.bucketStart, bucket.volumeUsd, bucket.grossFeeUsd, bucket.lpFeeUsd, bucket.swapCount, bucket.buyVolumeUsd, bucket.sellVolumeUsd, bucket.uniqueWalletCount, bucket.tvlStart, bucket.tvlEnd, bucket.activeTvl, bucket.feeDensity, bucket.liquidityVelocity, bucket.coverageRatio, bucket.status, bucket.source, bucket.asOf);
    }
    noteStorageWrites("pool_metrics_1m", buckets.length);
    return { rows: buckets.length, error: null };
  } catch (error) {
    return { rows: 0, error: error instanceof Error ? error.message : "1分钟桶落库失败" };
  }
}

export function readMinuteBuckets(poolIds: string[], since: Date): MinuteBucket[] {
  const db = getDatabase();
  if (!db || poolIds.length === 0) return [];
  try {
    const placeholders = poolIds.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT pool_id, bucket_start, volume_usd, gross_fee_usd, lp_fee_usd, swap_count, buy_volume_usd, sell_volume_usd, unique_wallet_count, tvl_start, tvl_end, active_tvl, fee_density, liquidity_velocity, coverage_ratio, status, source, as_of
      FROM pool_metrics_1m WHERE pool_id IN (${placeholders}) AND bucket_start >= ? ORDER BY bucket_start DESC
    `).all(...poolIds, since.toISOString()) as Array<Record<string, unknown>>;
    return rows.flatMap((row) => {
      if (typeof row.pool_id !== "string" || typeof row.bucket_start !== "string" || typeof row.volume_usd !== "number" || typeof row.swap_count !== "number" || typeof row.buy_volume_usd !== "number" || typeof row.sell_volume_usd !== "number" || typeof row.status !== "string" || typeof row.source !== "string" || typeof row.as_of !== "string") return [];
      return [{
        poolId: row.pool_id,
        bucketStart: row.bucket_start,
        volumeUsd: row.volume_usd,
        grossFeeUsd: typeof row.gross_fee_usd === "number" ? row.gross_fee_usd : null,
        lpFeeUsd: typeof row.lp_fee_usd === "number" ? row.lp_fee_usd : null,
        swapCount: row.swap_count,
        buyVolumeUsd: row.buy_volume_usd,
        sellVolumeUsd: row.sell_volume_usd,
        uniqueWalletCount: typeof row.unique_wallet_count === "number" ? row.unique_wallet_count : null,
        tvlStart: typeof row.tvl_start === "number" ? row.tvl_start : null,
        tvlEnd: typeof row.tvl_end === "number" ? row.tvl_end : null,
        activeTvl: typeof row.active_tvl === "number" ? row.active_tvl : null,
        feeDensity: typeof row.fee_density === "number" ? row.fee_density : null,
        liquidityVelocity: typeof row.liquidity_velocity === "number" ? row.liquidity_velocity : null,
        coverageRatio: typeof row.coverage_ratio === "number" ? row.coverage_ratio : null,
        status: row.status === "COMPLETE" || row.status === "PARTIAL" || row.status === "RUNNING" || row.status === "BACKFILLING" || row.status === "STALLED" || row.status === "BLOCKED" || row.status === "LIVE" || row.status === "INVALID" ? row.status : "UNAVAILABLE",
        source: row.source,
        asOf: row.as_of,
      } satisfies MinuteBucket];
    });
  } catch {
    return [];
  }
}

export function persistIndexerState(key: string, payload: unknown): { error: string | null } {
  const db = getDatabase();
  if (!db) return { error: databaseError ?? "SQLite 不可用" };
  try {
    db.prepare("INSERT OR REPLACE INTO indexer_state (state_key, payload_json, updated_at) VALUES (?, ?, ?)").run(key, JSON.stringify(payload), new Date().toISOString());
    noteStorageWrites("indexer_state", 1);
    return { error: null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Indexer 状态落库失败" };
  }
}

export function readIndexerState<T>(key: string): T | null {
  const db = getDatabase();
  if (!db) return null;
  try {
    const row = db.prepare("SELECT payload_json FROM indexer_state WHERE state_key = ?").get(key) as { payload_json?: unknown } | undefined;
    return typeof row?.payload_json === "string" ? JSON.parse(row.payload_json) as T : null;
  } catch {
    return null;
  }
}

export type StoredMarketProjection = {
  projectionVersion: number;
  sourceTimestamp: string;
  receivedAt: string;
  snapshot: unknown;
  rankings: unknown;
  sourceHealth: unknown;
  createdAt: string;
};

export function persistMarketProjection(input: Omit<StoredMarketProjection, "createdAt">): { error: string | null } {
  const db = getDatabase();
  if (!db) return { error: databaseError ?? "SQLite 不可用" };
  const createdAt = new Date().toISOString();
  try {
    db.prepare(`
      INSERT OR REPLACE INTO market_projection_snapshots
      (projection_version, snapshot_json, rankings_json, source_health_json, source_timestamp, received_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.projectionVersion,
      JSON.stringify(input.snapshot),
      JSON.stringify(input.rankings),
      JSON.stringify(input.sourceHealth),
      input.sourceTimestamp,
      input.receivedAt,
      createdAt,
    );
    db.prepare("DELETE FROM market_projection_snapshots WHERE projection_version < ?").run(Math.max(0, input.projectionVersion - 20));
    noteStorageWrites("market_projection_snapshots", 1);
    return { error: null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "MarketProjection 落库失败" };
  }
}

export function readLatestMarketProjection(): StoredMarketProjection | null {
  const db = getDatabase();
  if (!db) return null;
  try {
    const row = db.prepare(`
      SELECT projection_version, snapshot_json, rankings_json, source_health_json, source_timestamp, received_at, created_at
      FROM market_projection_snapshots ORDER BY projection_version DESC LIMIT 1
    `).get() as Record<string, unknown> | undefined;
    if (!row || typeof row.projection_version !== "number" || typeof row.snapshot_json !== "string" || typeof row.rankings_json !== "string" || typeof row.source_health_json !== "string" || typeof row.source_timestamp !== "string" || typeof row.received_at !== "string" || typeof row.created_at !== "string") return null;
    return {
      projectionVersion: row.projection_version,
      sourceTimestamp: row.source_timestamp,
      receivedAt: row.received_at,
      snapshot: JSON.parse(row.snapshot_json),
      rankings: JSON.parse(row.rankings_json),
      sourceHealth: JSON.parse(row.source_health_json),
      createdAt: row.created_at,
    };
  } catch {
    return null;
  }
}

export function checkpointEventDatabase(): { ok: boolean; detail: string } {
  const db = getDatabase();
  if (!db) return { ok: false, detail: databaseError ?? "SQLite 不可用" };
  try {
    db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    return { ok: true, detail: "WAL checkpoint complete" };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "WAL checkpoint 失败" };
  }
}

export function checkEventDatabaseIntegrity(): { ok: boolean; detail: string; migrations: Array<{ id: string; sha256: string }> } {
  const db = getDatabase();
  if (!db) return { ok: false, detail: databaseError ?? "SQLite 不可用", migrations: [] };
  try {
    const result = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
    const migrations = db.prepare("SELECT migration_id, sha256 FROM schema_migrations ORDER BY migration_id").all() as Array<{ migration_id?: unknown; sha256?: unknown }>;
    return {
      ok: result?.integrity_check === "ok",
      detail: typeof result?.integrity_check === "string" ? result.integrity_check : "SQLite integrity_check 无结果",
      migrations: migrations.flatMap((row) => typeof row.migration_id === "string" && typeof row.sha256 === "string" ? [{ id: row.migration_id, sha256: row.sha256 }] : []),
    };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "SQLite 完整性检查失败", migrations: [] };
  }
}

export type StoredSwitchSignal = {
  signalId: string;
  pairId: string;
  fromPool: string | null;
  toPool: string | null;
  state: "NONE" | "WATCHING" | "CONFIRMED" | "COOLDOWN" | "INVALIDATED";
  score: number | null;
  reason: string[];
  startedAt: string;
  confirmedAt: string | null;
  invalidatedAt: string | null;
  lastSeenAt: string;
  projectionVersion: number;
};

export function persistSwitchSignal(signal: StoredSwitchSignal): { error: string | null } {
  const db = getDatabase();
  if (!db) return { error: databaseError ?? "SQLite 不可用" };
  try {
    db.prepare(`
      INSERT OR REPLACE INTO switch_signals
      (signal_id, pair_id, from_pool, to_pool, state, score, reason_json, started_at, confirmed_at, invalidated_at, last_seen_at, projection_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(signal.signalId, signal.pairId, signal.fromPool, signal.toPool, signal.state, signal.score, JSON.stringify(signal.reason), signal.startedAt, signal.confirmedAt, signal.invalidatedAt, signal.lastSeenAt, signal.projectionVersion);
    noteStorageWrites("switch_signals", 1);
    return { error: null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "切换信号落库失败" };
  }
}

export function readSwitchSignals(limit = 100): StoredSwitchSignal[] {
  const db = getDatabase();
  if (!db) return [];
  try {
    const rows = db.prepare(`
      SELECT signal_id, pair_id, from_pool, to_pool, state, score, reason_json, started_at, confirmed_at, invalidated_at, last_seen_at, projection_version
      FROM switch_signals ORDER BY last_seen_at DESC LIMIT ?
    `).all(Math.max(1, Math.min(500, limit))) as Array<Record<string, unknown>>;
    return rows.flatMap((row) => {
      if (typeof row.signal_id !== "string" || typeof row.pair_id !== "string" || typeof row.state !== "string" || typeof row.started_at !== "string" || typeof row.last_seen_at !== "string" || typeof row.projection_version !== "number") return [];
      let reason: string[] = [];
      try { const parsed = JSON.parse(typeof row.reason_json === "string" ? row.reason_json : "[]"); reason = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []; } catch { /* 空理由 */ }
      const state = ["NONE", "WATCHING", "CONFIRMED", "COOLDOWN", "INVALIDATED"].includes(row.state) ? row.state as StoredSwitchSignal["state"] : "NONE";
      return [{
        signalId: row.signal_id,
        pairId: row.pair_id,
        fromPool: typeof row.from_pool === "string" ? row.from_pool : null,
        toPool: typeof row.to_pool === "string" ? row.to_pool : null,
        state,
        score: typeof row.score === "number" ? row.score : null,
        reason,
        startedAt: row.started_at,
        confirmedAt: typeof row.confirmed_at === "string" ? row.confirmed_at : null,
        invalidatedAt: typeof row.invalidated_at === "string" ? row.invalidated_at : null,
        lastSeenAt: row.last_seen_at,
        projectionVersion: row.projection_version,
      } satisfies StoredSwitchSignal];
    });
  } catch {
    return [];
  }
}

function parseProgressHistory(value: unknown): BackfillJobSnapshot["progressHistory"] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      return typeof row.at === "string" && typeof row.completedPoolCount === "number"
        ? [{ at: row.at, completedPoolCount: row.completedPoolCount, oldestCoveredAt: typeof row.oldestCoveredAt === "string" ? row.oldestCoveredAt : null, transactionsFetched: typeof row.transactionsFetched === "number" ? row.transactionsFetched : undefined }]
        : [];
    }) : [];
  } catch {
    return [];
  }
}

export function persistBackfillJob(job: BackfillJobSnapshot): { error: string | null } {
  const db = getDatabase();
  if (!db) return { error: databaseError ?? "SQLite 不可用" };
  try {
    db.prepare(`
      INSERT OR REPLACE INTO backfill_jobs
      (job_id, target_window, target_block_time, started_at, last_progress_at, status, target_pool_count, completed_pool_count, oldest_covered_at, signatures_discovered, transactions_fetched, transactions_parsed, transactions_failed, unknown_instructions, requests_last_5m, successful_transactions_last_5m, rpc429_last_5m, current_cursor_time, estimated_finish_at, eta_ms, restart_count, blocked_reason, progress_history_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.jobId,
      job.targetWindow,
      job.targetBlockTime,
      job.startedAt,
      job.lastProgressAt,
      job.status,
      job.targetPoolCount,
      job.completedPoolCount,
      job.oldestCoveredAt,
      job.signaturesDiscovered,
      job.transactionsFetched,
      job.transactionsParsed,
      job.transactionsFailed,
      job.unknownInstructions,
      job.requestsLast5m,
      job.successfulTransactionsLast5m,
      job.rpc429Last5m,
      job.currentCursorTime,
      job.estimatedFinishAt,
      job.etaMs,
      job.restartCount,
      job.blockedReason,
      JSON.stringify(job.progressHistory),
      new Date().toISOString(),
    );
    noteStorageWrites("backfill_jobs", 1);
    return { error: null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "回补任务状态落库失败" };
  }
}

export function readBackfillJob(jobId: string): BackfillJobSnapshot | null {
  const db = getDatabase();
  if (!db) return null;
  try {
    const row = db.prepare("SELECT job_id, target_window, target_block_time, started_at, last_progress_at, status, target_pool_count, completed_pool_count, oldest_covered_at, signatures_discovered, transactions_fetched, transactions_parsed, transactions_failed, unknown_instructions, requests_last_5m, successful_transactions_last_5m, rpc429_last_5m, current_cursor_time, estimated_finish_at, eta_ms, restart_count, blocked_reason, progress_history_json FROM backfill_jobs WHERE job_id = ?").get(jobId) as Record<string, unknown> | undefined;
    if (!row || typeof row.job_id !== "string" || typeof row.target_block_time !== "string" || typeof row.started_at !== "string" || typeof row.status !== "string") return null;
    const status: BackfillJobSnapshot["status"] = ["RUNNING", "LIVE", "STALLED", "BLOCKED", "FAILED", "STOPPED", "BACKFILL_PROGRESS_INVALID"].includes(row.status) ? row.status as BackfillJobSnapshot["status"] : "STOPPED";
    return {
      jobId: row.job_id,
      targetWindow: "12h",
      targetBlockTime: row.target_block_time,
      startedAt: row.started_at,
      lastProgressAt: typeof row.last_progress_at === "string" ? row.last_progress_at : null,
      status,
      targetPoolCount: typeof row.target_pool_count === "number" ? row.target_pool_count : 0,
      completedPoolCount: typeof row.completed_pool_count === "number" ? row.completed_pool_count : 0,
      oldestCoveredAt: typeof row.oldest_covered_at === "string" ? row.oldest_covered_at : null,
      signaturesDiscovered: typeof row.signatures_discovered === "number" ? row.signatures_discovered : 0,
      transactionsFetched: typeof row.transactions_fetched === "number" ? row.transactions_fetched : 0,
      transactionsParsed: typeof row.transactions_parsed === "number" ? row.transactions_parsed : 0,
      transactionsFailed: typeof row.transactions_failed === "number" ? row.transactions_failed : 0,
      unknownInstructions: typeof row.unknown_instructions === "number" ? row.unknown_instructions : 0,
      requestsLast5m: typeof row.requests_last_5m === "number" ? row.requests_last_5m : 0,
      successfulTransactionsLast5m: typeof row.successful_transactions_last_5m === "number" ? row.successful_transactions_last_5m : 0,
      rpc429Last5m: typeof row.rpc429_last_5m === "number" ? row.rpc429_last_5m : 0,
      currentCursorTime: typeof row.current_cursor_time === "string" ? row.current_cursor_time : null,
      estimatedFinishAt: typeof row.estimated_finish_at === "string" ? row.estimated_finish_at : null,
      etaMs: typeof row.eta_ms === "number" ? row.eta_ms : null,
      restartCount: typeof row.restart_count === "number" ? row.restart_count : 0,
      blockedReason: typeof row.blocked_reason === "string" ? row.blocked_reason : null,
      progressHistory: parseProgressHistory(row.progress_history_json),
    };
  } catch {
    return null;
  }
}

export function persistBackfillPoolCursors(jobId: string, cursors: BackfillPoolCursor[]): { rows: number; error: string | null } {
  const db = getDatabase();
  if (!db || cursors.length === 0) return { rows: 0, error: db ? null : databaseError ?? "SQLite 不可用" };
  try {
    const insert = db.prepare(`
      INSERT OR REPLACE INTO backfill_pool_cursors
      (job_id, pool_address, oldest_fetched_signature, oldest_fetched_block_time, oldest_fetched_slot, target_block_time, signatures_discovered, transactions_fetched, transactions_parsed, transactions_failed, unknown_instructions, last_progress_at, retry_count, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.exec("BEGIN");
    for (const cursor of cursors) insert.run(jobId, cursor.poolAddress, cursor.oldestFetchedSignature, cursor.oldestFetchedBlockTime, cursor.oldestFetchedSlot, cursor.targetBlockTime, cursor.signaturesDiscovered, cursor.transactionsFetched, cursor.transactionsParsed, cursor.transactionsFailed, cursor.unknownInstructions, cursor.lastProgressAt, cursor.retryCount, cursor.status);
    db.exec("COMMIT");
    noteStorageWrites("backfill_pool_cursors", cursors.length);
    return { rows: cursors.length, error: null };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* 保留原始错误 */ }
    return { rows: 0, error: error instanceof Error ? error.message : "Pool 回补游标落库失败" };
  }
}

export function readBackfillPoolCursors(jobId: string, poolIds?: string[]): BackfillPoolCursor[] {
  const db = getDatabase();
  if (!db) return [];
  try {
    const filter = poolIds && poolIds.length > 0 ? ` AND pool_address IN (${poolIds.map(() => "?").join(",")})` : "";
    const rows = db.prepare(`SELECT pool_address, oldest_fetched_signature, oldest_fetched_block_time, oldest_fetched_slot, target_block_time, signatures_discovered, transactions_fetched, transactions_parsed, transactions_failed, unknown_instructions, last_progress_at, retry_count, status FROM backfill_pool_cursors WHERE job_id = ?${filter}`).all(jobId, ...(poolIds ?? [])) as Array<Record<string, unknown>>;
    return rows.flatMap((row) => typeof row.pool_address === "string" && typeof row.target_block_time === "string" ? [{
      poolAddress: row.pool_address,
      oldestFetchedSignature: typeof row.oldest_fetched_signature === "string" ? row.oldest_fetched_signature : null,
      oldestFetchedBlockTime: typeof row.oldest_fetched_block_time === "string" ? row.oldest_fetched_block_time : null,
      oldestFetchedSlot: typeof row.oldest_fetched_slot === "number" ? row.oldest_fetched_slot : null,
      targetBlockTime: row.target_block_time,
      signaturesDiscovered: typeof row.signatures_discovered === "number" ? row.signatures_discovered : 0,
      transactionsFetched: typeof row.transactions_fetched === "number" ? row.transactions_fetched : 0,
      transactionsParsed: typeof row.transactions_parsed === "number" ? row.transactions_parsed : 0,
      transactionsFailed: typeof row.transactions_failed === "number" ? row.transactions_failed : 0,
      unknownInstructions: typeof row.unknown_instructions === "number" ? row.unknown_instructions : 0,
      lastProgressAt: typeof row.last_progress_at === "string" ? row.last_progress_at : null,
      retryCount: typeof row.retry_count === "number" ? row.retry_count : 0,
      status: ["PENDING", "RUNNING", "COMPLETE", "STALLED", "BLOCKED", "FAILED"].includes(String(row.status)) ? row.status as BackfillPoolCursor["status"] : "PENDING",
    }] : []);
  } catch {
    return [];
  }
}

export function persistBackfillFailures(failures: BackfillFailure[]): { rows: number; error: string | null } {
  const db = getDatabase();
  if (!db || failures.length === 0) return { rows: 0, error: db ? null : databaseError ?? "SQLite 不可用" };
  try {
    const insert = db.prepare("INSERT INTO backfill_failures (job_id, pool_address, signature, method, error, retry_count, first_seen_at, last_seen_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const item of failures) insert.run(item.jobId, item.poolAddress, item.signature, item.method, item.error, item.retryCount, item.firstSeenAt, item.lastSeenAt, item.resolvedAt);
    noteStorageWrites("backfill_failures", failures.length);
    return { rows: failures.length, error: null };
  } catch (error) {
    return { rows: 0, error: error instanceof Error ? error.message : "回补失败记录落库失败" };
  }
}

export function readBackfillFailures(jobId: string, limit = 100): BackfillFailure[] {
  const db = getDatabase();
  if (!db) return [];
  try {
    const rows = db.prepare("SELECT job_id, pool_address, signature, method, error, retry_count, first_seen_at, last_seen_at, resolved_at FROM backfill_failures WHERE job_id = ? ORDER BY last_seen_at DESC LIMIT ?").all(jobId, limit) as Array<Record<string, unknown>>;
    return rows.flatMap((row) => typeof row.pool_address === "string" && typeof row.method === "string" && typeof row.error === "string" && typeof row.first_seen_at === "string" && typeof row.last_seen_at === "string" ? [{
      jobId: typeof row.job_id === "string" ? row.job_id : jobId,
      poolAddress: row.pool_address,
      signature: typeof row.signature === "string" ? row.signature : null,
      method: row.method,
      error: row.error,
      retryCount: typeof row.retry_count === "number" ? row.retry_count : 0,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      resolvedAt: typeof row.resolved_at === "string" ? row.resolved_at : null,
    }] : []);
  } catch {
    return [];
  }
}

export function persistRpcAccountCache(entries: RpcAccountCacheEntry[]): { rows: number; error: string | null } {
  const db = getDatabase();
  if (!db || entries.length === 0) return { rows: 0, error: db ? null : databaseError ?? "SQLite 不可用" };
  try {
    const insert = db.prepare("INSERT OR REPLACE INTO rpc_account_cache (address, cache_kind, payload_json, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?)");
    for (const entry of entries) insert.run(entry.address, entry.kind, JSON.stringify(entry.payload), entry.fetchedAt, entry.expiresAt);
    noteStorageWrites("rpc_account_cache", entries.length);
    return { rows: entries.length, error: null };
  } catch (error) {
    return { rows: 0, error: error instanceof Error ? error.message : "RPC 账户缓存落库失败" };
  }
}

export function readRpcAccountCache(addresses: string[], kind: RpcAccountCacheEntry["kind"], maxAgeMs: number): Map<string, unknown> {
  const db = getDatabase();
  const result = new Map<string, unknown>();
  if (!db || addresses.length === 0) return result;
  try {
    const placeholders = addresses.map(() => "?").join(",");
    const rows = db.prepare(`SELECT address, payload_json, fetched_at, expires_at FROM rpc_account_cache WHERE cache_kind = ? AND address IN (${placeholders})`).all(kind, ...addresses) as Array<Record<string, unknown>>;
    const minFetchedAt = Date.now() - maxAgeMs;
    for (const row of rows) {
      if (typeof row.address !== "string" || typeof row.payload_json !== "string" || typeof row.fetched_at !== "string" || typeof row.expires_at !== "string" || Date.parse(row.expires_at) < Date.now() || Date.parse(row.fetched_at) < minFetchedAt) continue;
      try {
        result.set(row.address, JSON.parse(row.payload_json));
      } catch {
        // 单个缓存损坏时跳过，不能阻塞其它账户。
      }
    }
  } catch {
    // 缓存读取失败时回退 RPC，不影响公开 API。
  }
  return result;
}

export function persistRpcTransactionCache(entries: CachedRpcTransaction[]): { rows: number; error: string | null } {
  const db = getDatabase();
  if (!db || entries.length === 0) return { rows: 0, error: db ? null : databaseError ?? "SQLite 不可用" };
  try {
    const insert = db.prepare(`
      INSERT OR REPLACE INTO rpc_transaction_cache
      (signature, slot, block_time, payload_json, status, error, fetched_at, provider_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const entry of entries) insert.run(entry.signature, entry.slot, entry.blockTime, entry.payload === null ? null : JSON.stringify(entry.payload), entry.status, entry.error, entry.fetchedAt, entry.providerUrl);
    noteStorageWrites("rpc_transaction_cache", entries.length);
    return { rows: entries.length, error: null };
  } catch (error) {
    return { rows: 0, error: error instanceof Error ? error.message : "RPC 交易缓存落库失败" };
  }
}

export function readRpcTransactionCache(signatures: string[]): Map<string, CachedRpcTransaction> {
  const db = getDatabase();
  const result = new Map<string, CachedRpcTransaction>();
  if (!db || signatures.length === 0) return result;
  try {
    const placeholders = signatures.map(() => "?").join(",");
    const rows = db.prepare(`SELECT signature, slot, block_time, payload_json, status, error, fetched_at, provider_url FROM rpc_transaction_cache WHERE signature IN (${placeholders})`).all(...signatures) as Array<Record<string, unknown>>;
    for (const row of rows) {
      if (typeof row.signature !== "string" || typeof row.status !== "string" || typeof row.fetched_at !== "string") continue;
      let payload: unknown = null;
      try { payload = typeof row.payload_json === "string" ? JSON.parse(row.payload_json) : null; } catch { payload = null; }
      result.set(row.signature, {
        signature: row.signature,
        slot: typeof row.slot === "number" ? row.slot : null,
        blockTime: typeof row.block_time === "number" ? row.block_time : null,
        payload,
        status: row.status === "SUCCESS" ? "SUCCESS" : "FAILED",
        error: typeof row.error === "string" ? row.error : null,
        fetchedAt: row.fetched_at,
        providerUrl: typeof row.provider_url === "string" ? row.provider_url : null,
      });
    }
  } catch {
    // 缓存读取失败时允许上层继续请求。
  }
  return result;
}

const SWAP_ERROR_CATEGORIES = new Set<SwapErrorCategory>([
  "RPC_429",
  "RPC_TIMEOUT",
  "RPC_NETWORK_ERROR",
  "TRANSACTION_NOT_AVAILABLE",
  "TRANSACTION_VERSION_UNSUPPORTED",
  "ADDRESS_LOOKUP_TABLE_FAILED",
  "ONCHAIN_TRANSACTION_FAILED",
  "NOT_TARGET_POOL",
  "NOT_RAYDIUM_SWAP",
  "PROGRAM_UNSUPPORTED",
  "INSTRUCTION_DISCRIMINATOR_UNKNOWN",
  "INNER_INSTRUCTIONS_MISSING",
  "ACCOUNT_INDEX_INVALID",
  "TOKEN_BALANCE_MISSING",
  "TOKEN_DECIMALS_MISSING",
  "AMOUNT_RECONCILIATION_FAILED",
  "FEE_CONFIG_MISSING",
  "FEE_VERSION_UNSUPPORTED",
  "PARSE_EXCEPTION",
  "PARSED_SWAP",
]);

function asSwapErrorCategory(value: unknown): SwapErrorCategory | null {
  return typeof value === "string" && SWAP_ERROR_CATEGORIES.has(value as SwapErrorCategory) ? value as SwapErrorCategory : null;
}

export function persistRawTransactions(entries: RawTransactionCacheEntry[]): { rows: number; error: string | null } {
  const db = getDatabase();
  if (!db || entries.length === 0) return { rows: 0, error: db ? null : databaseError ?? "SQLite 不可用" };
  try {
    const insert = db.prepare(`
      INSERT OR REPLACE INTO raw_transactions
      (signature, slot, block_time, transaction_json, fetch_status, fetched_at, rpc_endpoint, sha256, error_category, error_code, error_message, retryable, attempt_count, first_seen_at, last_attempt_at, parser_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const entry of entries) {
      insert.run(
        entry.signature,
        entry.slot,
        entry.blockTime,
        entry.transactionJson,
        entry.fetchStatus,
        entry.fetchedAt,
        entry.rpcEndpoint,
        entry.sha256,
        entry.errorCategory,
        entry.errorCode,
        entry.errorMessage,
        entry.retryable ? 1 : 0,
        entry.attemptCount,
        entry.firstSeenAt,
        entry.lastAttemptAt,
        entry.parserVersion,
      );
    }
    noteStorageWrites("raw_transactions", entries.length);
    return { rows: entries.length, error: null };
  } catch (error) {
    return { rows: 0, error: error instanceof Error ? error.message : "raw transaction 缓存落库失败" };
  }
}

export function readRawTransactions(signatures: string[]): Map<string, RawTransactionCacheEntry> {
  const db = getDatabase();
  const result = new Map<string, RawTransactionCacheEntry>();
  if (!db || signatures.length === 0) return result;
  try {
    const placeholders = signatures.map(() => "?").join(",");
    const rows = db.prepare(`SELECT signature, slot, block_time, transaction_json, fetch_status, fetched_at, rpc_endpoint, sha256, error_category, error_code, error_message, retryable, attempt_count, first_seen_at, last_attempt_at, parser_version FROM raw_transactions WHERE signature IN (${placeholders})`).all(...signatures) as Array<Record<string, unknown>>;
    for (const row of rows) {
      if (typeof row.signature !== "string" || typeof row.fetch_status !== "string" || typeof row.fetched_at !== "string" || typeof row.first_seen_at !== "string" || typeof row.last_attempt_at !== "string" || typeof row.parser_version !== "string") continue;
      result.set(row.signature, {
        signature: row.signature,
        slot: typeof row.slot === "number" ? row.slot : null,
        blockTime: typeof row.block_time === "number" ? row.block_time : null,
        transactionJson: typeof row.transaction_json === "string" ? row.transaction_json : null,
        fetchStatus: row.fetch_status === "SUCCESS" ? "SUCCESS" : "FAILED",
        fetchedAt: row.fetched_at,
        rpcEndpoint: typeof row.rpc_endpoint === "string" ? row.rpc_endpoint : null,
        sha256: typeof row.sha256 === "string" ? row.sha256 : null,
        errorCategory: asSwapErrorCategory(row.error_category),
        errorCode: typeof row.error_code === "string" ? row.error_code : null,
        errorMessage: typeof row.error_message === "string" ? row.error_message : null,
        retryable: row.retryable === 1,
        attemptCount: typeof row.attempt_count === "number" ? row.attempt_count : 1,
        firstSeenAt: row.first_seen_at,
        lastAttemptAt: row.last_attempt_at,
        parserVersion: row.parser_version,
      });
    }
  } catch {
    // 缓存读取失败时由上层回退到 legacy cache/RPC，不阻塞公开数据。
  }
  return result;
}

/**
 * 返回指定 Pool 在窗口内仍需重试的 raw transaction。
 * 游标可能已经越过失败签名，因此重试不能依赖下一页 signatures；必须从
 * 持久化的失败缓存恢复，否则窗口会永远停在 BACKFILLING。
 */
export function readRetryableRawTransactions(poolAddress: string, windowStart: Date): RawTransactionCacheEntry[] {
  const db = getDatabase();
  if (!db) return [];
  try {
    const rows = db.prepare(`
      SELECT DISTINCT rt.signature
      FROM raw_transactions rt
      INNER JOIN transaction_classifications tc ON tc.signature = rt.signature
      WHERE tc.pool_address = ?
        AND rt.fetch_status = 'FAILED'
        AND rt.retryable = 1
        AND (rt.block_time IS NULL OR rt.block_time >= ?)
      ORDER BY COALESCE(rt.block_time, 0) DESC, rt.signature
    `).all(poolAddress, Math.floor(windowStart.getTime() / 1_000)) as Array<Record<string, unknown>>;
    const signatures = rows.flatMap((row) => typeof row.signature === "string" ? [row.signature] : []);
    return [...readRawTransactions(signatures).values()];
  } catch {
    return [];
  }
}

export function persistTransactionClassifications(entries: TransactionClassification[]): { rows: number; error: string | null } {
  const db = getDatabase();
  if (!db || entries.length === 0) return { rows: 0, error: db ? null : databaseError ?? "SQLite 不可用" };
  try {
    // 一次重新解析代表该 transaction 的完整分类结果。先按 signature+pool
    // 清掉旧的 NULL instruction RPC 失败记录，再写入本次全部 instruction
    // 分类；否则成功重试后旧失败仍会被窗口计为 unresolved。
    const removePrevious = db.prepare("DELETE FROM transaction_classifications WHERE signature = ? AND COALESCE(pool_address, '') = COALESCE(?, '')");
    const insert = db.prepare(`
      INSERT OR REPLACE INTO transaction_classifications
      (classification_key, signature, slot, block_time, pool_address, program_id, transaction_version, error_category, error_code, error_message, retryable, attempt_count, first_seen_at, last_attempt_at, raw_transaction_path, parser_version, instruction_index, discriminator, account_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const cleared = new Set<string>();
    for (const entry of entries) {
      const groupKey = `${entry.signature}:${entry.poolAddress ?? "-"}`;
      if (!cleared.has(groupKey)) {
        removePrevious.run(entry.signature, entry.poolAddress);
        cleared.add(groupKey);
      }
      const key = `${entry.signature}:${entry.poolAddress ?? "-"}:${entry.instructionIndex ?? -1}`;
      insert.run(
        key,
        entry.signature,
        entry.slot,
        entry.blockTime,
        entry.poolAddress,
        entry.programId,
        entry.transactionVersion === null ? null : String(entry.transactionVersion),
        entry.errorCategory,
        entry.errorCode,
        entry.errorMessage,
        entry.retryable ? 1 : 0,
        entry.attemptCount,
        entry.firstSeenAt,
        entry.lastAttemptAt,
        entry.rawTransactionPath,
        entry.parserVersion,
        entry.instructionIndex,
        entry.discriminator,
        entry.accountCount,
      );
    }
    noteStorageWrites("transaction_classifications", entries.length);
    return { rows: entries.length, error: null };
  } catch (error) {
    return { rows: 0, error: error instanceof Error ? error.message : "交易分类落库失败" };
  }
}

export function clearTransactionClassifications(parserVersion = "raydium-swap-parser-v2"): { rows: number; error: string | null } {
  const db = getDatabase();
  if (!db) return { rows: 0, error: databaseError ?? "SQLite 不可用" };
  try {
    const result = db.prepare("DELETE FROM transaction_classifications WHERE parser_version = ?").run(parserVersion);
    return { rows: Number(result.changes ?? 0), error: null };
  } catch (error) {
    return { rows: 0, error: error instanceof Error ? error.message : "交易分类旧版本清理失败" };
  }
}

export function clearNormalizedSwaps(parseVersion: string, poolIds: string[]): { rows: number; error: string | null } {
  const db = getDatabase();
  if (!db || poolIds.length === 0) return { rows: 0, error: db ? null : databaseError ?? "SQLite 不可用" };
  try {
    const placeholders = poolIds.map(() => "?").join(",");
    const result = db.prepare(`DELETE FROM normalized_swaps WHERE parse_version = ? AND pool_address IN (${placeholders})`).run(parseVersion, ...poolIds);
    return { rows: Number(result.changes ?? 0), error: null };
  } catch (error) {
    return { rows: 0, error: error instanceof Error ? error.message : "标准化 Swap 旧版本清理失败" };
  }
}

export function readTransactionClassificationCounts(poolAddress: string | null = null): Record<string, number> {
  const db = getDatabase();
  if (!db) return {};
  try {
    const rows = poolAddress === null
      ? db.prepare("SELECT error_category, COUNT(*) AS count FROM transaction_classifications GROUP BY error_category").all() as Array<Record<string, unknown>>
      : db.prepare("SELECT error_category, COUNT(*) AS count FROM transaction_classifications WHERE pool_address = ? GROUP BY error_category").all(poolAddress) as Array<Record<string, unknown>>;
    return Object.fromEntries(rows.flatMap((row) => typeof row.error_category === "string" && typeof row.count === "number" ? [[row.error_category, row.count] as const] : []));
  } catch {
    return {};
  }
}

export type ParserFunnelSnapshot = {
  transactionsLoaded: number;
  onchainSuccess: number;
  containsTargetPool: number;
  raydiumSwapCandidate: number;
  parsedSwap: number;
  unsupportedSwap: number;
  amountReconciliationFailed: number;
  candidateTransactions: number;
  parsedSwapTransactions: number;
  classificationRows: number;
  normalizedSwapRows: number;
  normalizedSwapRowsByVersion: Record<string, number>;
  distinctParsedSignatures: number;
  multipleSwapTransactions: number;
  realParseSuccessRate: number | null;
};

const RPC_CLASSIFICATION_CATEGORIES = ["RPC_429", "RPC_TIMEOUT", "RPC_NETWORK_ERROR", "TRANSACTION_NOT_AVAILABLE"];
const RAYDIUM_SWAP_CANDIDATE_CATEGORIES = [
  "PARSED_SWAP",
  "AMOUNT_RECONCILIATION_FAILED",
  "TOKEN_BALANCE_MISSING",
  "TOKEN_DECIMALS_MISSING",
  "FEE_CONFIG_MISSING",
  "FEE_VERSION_UNSUPPORTED",
  "PROGRAM_UNSUPPORTED",
  "INSTRUCTION_DISCRIMINATOR_UNKNOWN",
  "INNER_INSTRUCTIONS_MISSING",
  "ACCOUNT_INDEX_INVALID",
  "PARSE_EXCEPTION",
];
const UNSUPPORTED_SWAP_CATEGORIES = ["PROGRAM_UNSUPPORTED", "INSTRUCTION_DISCRIMINATOR_UNKNOWN", "FEE_VERSION_UNSUPPORTED"];

function countDistinctSignatures(db: DatabaseHandle, where: string, args: Array<string | number | null>): number {
  const row = db.prepare(`SELECT COUNT(DISTINCT signature) AS count FROM transaction_classifications WHERE ${where}`).get(...args) as { count?: unknown } | undefined;
  return typeof row?.count === "number" ? row.count : 0;
}

function countClassificationRows(db: DatabaseHandle, where: string, args: Array<string | number | null>): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM transaction_classifications WHERE ${where}`).get(...args) as { count?: unknown } | undefined;
  return typeof row?.count === "number" ? row.count : 0;
}

export function readUnresolvedRetryableTransactions(poolAddress: string, windowStart: Date, parserVersion = "raydium-swap-parser-v2"): number {
  const db = getDatabase();
  if (!db) return 0;
  try {
    const row = db.prepare(`
      SELECT COUNT(DISTINCT tc.signature) AS count
      FROM transaction_classifications tc
      INNER JOIN raw_transactions rt ON rt.signature = tc.signature
      WHERE tc.pool_address = ?
        AND tc.parser_version = ?
        AND tc.retryable = 1
        AND rt.fetch_status = 'FAILED'
        AND rt.retryable = 1
        AND (rt.block_time IS NULL OR rt.block_time >= ?)
    `).get(poolAddress, parserVersion, Math.floor(windowStart.getTime() / 1_000)) as { count?: unknown } | undefined;
    return typeof row?.count === "number" ? row.count : 0;
  } catch {
    return 0;
  }
}

export function readParserFunnel(poolAddress: string, since: Date | null = null, parserVersion = "raydium-swap-parser-v2"): ParserFunnelSnapshot {
  const empty: ParserFunnelSnapshot = {
    transactionsLoaded: 0,
    onchainSuccess: 0,
    containsTargetPool: 0,
    raydiumSwapCandidate: 0,
    parsedSwap: 0,
    unsupportedSwap: 0,
    amountReconciliationFailed: 0,
    candidateTransactions: 0,
    parsedSwapTransactions: 0,
    classificationRows: 0,
    normalizedSwapRows: 0,
    normalizedSwapRowsByVersion: {},
    distinctParsedSignatures: 0,
    multipleSwapTransactions: 0,
    realParseSuccessRate: null,
  };
  const db = getDatabase();
  if (!db) return empty;
  try {
    const timeClause = since ? " AND (block_time IS NULL OR block_time >= ?)" : "";
    const timeArgs = since ? [Math.floor(since.getTime() / 1_000)] : [];
    const baseArgs = [poolAddress, parserVersion, ...timeArgs];
    const loaded = countDistinctSignatures(db, `pool_address = ? AND parser_version = ?${timeClause} AND error_category NOT IN (${RPC_CLASSIFICATION_CATEGORIES.map(() => "?").join(",")})`, [poolAddress, parserVersion, ...timeArgs, ...RPC_CLASSIFICATION_CATEGORIES]);
    const onchainSuccess = countDistinctSignatures(db, `pool_address = ? AND parser_version = ?${timeClause} AND error_category NOT IN (${[...RPC_CLASSIFICATION_CATEGORIES, "ONCHAIN_TRANSACTION_FAILED"].map(() => "?").join(",")})`, [poolAddress, parserVersion, ...timeArgs, ...RPC_CLASSIFICATION_CATEGORIES, "ONCHAIN_TRANSACTION_FAILED"]);
    const containsTargetPool = countDistinctSignatures(db, `pool_address = ? AND parser_version = ?${timeClause} AND error_category NOT IN (${[...RPC_CLASSIFICATION_CATEGORIES, "ONCHAIN_TRANSACTION_FAILED", "NOT_TARGET_POOL"].map(() => "?").join(",")})`, [poolAddress, parserVersion, ...timeArgs, ...RPC_CLASSIFICATION_CATEGORIES, "ONCHAIN_TRANSACTION_FAILED", "NOT_TARGET_POOL"]);
    const candidatePlaceholders = RAYDIUM_SWAP_CANDIDATE_CATEGORIES.map(() => "?").join(",");
    const candidateWhere = `pool_address = ? AND parser_version = ?${timeClause} AND error_category IN (${candidatePlaceholders})`;
    const candidateArgs = [poolAddress, parserVersion, ...timeArgs, ...RAYDIUM_SWAP_CANDIDATE_CATEGORIES];
    const parsedWhere = `pool_address = ? AND parser_version = ?${timeClause} AND error_category = ?`;
    const parsedArgs = [poolAddress, parserVersion, ...timeArgs, "PARSED_SWAP"];
    const unsupportedPlaceholders = UNSUPPORTED_SWAP_CATEGORIES.map(() => "?").join(",");
    const unsupported = countClassificationRows(db, `pool_address = ? AND parser_version = ?${timeClause} AND error_category IN (${unsupportedPlaceholders})`, [poolAddress, parserVersion, ...timeArgs, ...UNSUPPORTED_SWAP_CATEGORIES]);
    const amountReconciliationFailed = countClassificationRows(db, `pool_address = ? AND parser_version = ?${timeClause} AND error_category = ?`, [poolAddress, parserVersion, ...timeArgs, "AMOUNT_RECONCILIATION_FAILED"]);
    const raydiumSwapCandidate = countClassificationRows(db, candidateWhere, candidateArgs);
    const parsedSwap = countClassificationRows(db, parsedWhere, parsedArgs);
    const candidateTransactions = countDistinctSignatures(db, candidateWhere, candidateArgs);
    const parsedSwapTransactions = countDistinctSignatures(db, parsedWhere, parsedArgs);
    const classificationRows = countClassificationRows(db, `pool_address = ? AND parser_version = ?${timeClause}`, baseArgs);
    const distinctParsedSignatures = parsedSwapTransactions;
    const multipleRow = db.prepare(`SELECT COUNT(*) AS count FROM (SELECT signature FROM transaction_classifications WHERE ${parsedWhere} GROUP BY signature HAVING COUNT(*) > 1)`).get(...parsedArgs) as { count?: unknown } | undefined;
    const multipleSwapTransactions = typeof multipleRow?.count === "number" ? multipleRow.count : 0;
    const normalizedRows = db.prepare(`SELECT COUNT(*) AS count FROM normalized_swaps WHERE pool_address = ?${since ? " AND block_time >= ?" : ""}`).get(...(since ? [poolAddress, since.toISOString()] : [poolAddress])) as { count?: unknown } | undefined;
    const normalizedSwapRows = typeof normalizedRows?.count === "number" ? normalizedRows.count : 0;
    const versionRows = db.prepare(`SELECT parse_version, COUNT(*) AS count FROM normalized_swaps WHERE pool_address = ?${since ? " AND block_time >= ?" : ""} GROUP BY parse_version`).all(...(since ? [poolAddress, since.toISOString()] : [poolAddress])) as Array<Record<string, unknown>>;
    const normalizedSwapRowsByVersion = Object.fromEntries(versionRows.flatMap((row) => typeof row.parse_version === "string" && typeof row.count === "number" ? [[row.parse_version, row.count] as const] : []));
    return {
      ...empty,
      transactionsLoaded: loaded,
      onchainSuccess,
      containsTargetPool,
      raydiumSwapCandidate,
      parsedSwap,
      unsupportedSwap: unsupported,
      amountReconciliationFailed,
      candidateTransactions,
      parsedSwapTransactions,
      classificationRows,
      normalizedSwapRows,
      normalizedSwapRowsByVersion,
      distinctParsedSignatures,
      multipleSwapTransactions,
      realParseSuccessRate: raydiumSwapCandidate > 0 ? (parsedSwap / raydiumSwapCandidate) * 100 : null,
    };
  } catch {
    return empty;
  }
}

function classifyRpcFailureMessage(category: string | null, message: string | null): RpcFailureCategory | "RPC_429" {
  if (category === "RPC_429" || /\b429\b|rate.?limit/i.test(message ?? "")) return "RPC_429";
  const text = `${category ?? ""} ${message ?? ""}`.toLowerCase();
  if (/enotfound|eai_again|dns|name resolution|域名解析/.test(text)) return "DNS_ERROR";
  if (/econnreset|connection reset|socket hang up|连接重置/.test(text)) return "CONNECTION_RESET";
  if (/json|unexpected token|解析响应/.test(text)) return "JSON_PARSE_ERROR";
  if (/transaction.*null|返回空|gettransaction 返回空|not available/.test(text)) return "TRANSACTION_NULL";
  if (/closed|endpoint.*(close|down)|连接关闭/.test(text)) return "ENDPOINT_CLOSED";
  if (/^http\s+\d+|http_non_200|status\s*[4-5]\d\d/.test(text)) return "HTTP_NON_200";
  return "OTHER_NETWORK_ERROR";
}

export function reclassifyRpcFailureRecords(): { raw: Record<string, number>; classifications: Record<string, number> } {
  const db = getDatabase();
  const result = { raw: {} as Record<string, number>, classifications: {} as Record<string, number> };
  if (!db) return result;
  try {
    const rawRows = db.prepare("SELECT signature, error_category, error_message FROM raw_transactions WHERE error_category IN ('RPC_NETWORK_ERROR', 'RPC_429')").all() as Array<Record<string, unknown>>;
    const rawUpdate = db.prepare("UPDATE raw_transactions SET error_code = ? WHERE signature = ?");
    for (const row of rawRows) {
      if (typeof row.signature !== "string") continue;
      const classification = classifyRpcFailureMessage(typeof row.error_category === "string" ? row.error_category : null, typeof row.error_message === "string" ? row.error_message : null);
      rawUpdate.run(classification, row.signature);
      result.raw[classification] = (result.raw[classification] ?? 0) + 1;
    }
    const classificationRows = db.prepare("SELECT classification_key, error_category, error_message FROM transaction_classifications WHERE error_category IN ('RPC_NETWORK_ERROR', 'RPC_429')").all() as Array<Record<string, unknown>>;
    const classificationUpdate = db.prepare("UPDATE transaction_classifications SET error_code = ? WHERE classification_key = ?");
    for (const row of classificationRows) {
      if (typeof row.classification_key !== "string") continue;
      const classification = classifyRpcFailureMessage(typeof row.error_category === "string" ? row.error_category : null, typeof row.error_message === "string" ? row.error_message : null);
      classificationUpdate.run(classification, row.classification_key);
      result.classifications[classification] = (result.classifications[classification] ?? 0) + 1;
    }
  } catch {
    // 重新分类是诊断增强，不得阻塞事实层写入。
  }
  return result;
}

export function persistBackfillCheckpoint(checkpoint: BackfillCheckpoint): { error: string | null } {
  const db = getDatabase();
  if (!db) return { error: databaseError ?? "SQLite 不可用" };
  try {
    db.prepare(`
      INSERT OR REPLACE INTO backfill_checkpoints
      (checkpoint_key, window_key, program_id, before_signature, page, signatures_discovered, transactions_fetched, status, pool_tier, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(checkpoint.checkpointKey, checkpoint.windowKey, checkpoint.programId, checkpoint.beforeSignature, checkpoint.page, checkpoint.signaturesDiscovered, checkpoint.transactionsFetched, checkpoint.status, checkpoint.poolTier, checkpoint.updatedAt);
    noteStorageWrites("backfill_checkpoints", 1);
    return { error: null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "回补断点落库失败" };
  }
}

export function readBackfillCheckpoint(checkpointKey: string): BackfillCheckpoint | null {
  const db = getDatabase();
  if (!db) return null;
  try {
    const row = db.prepare("SELECT checkpoint_key, window_key, program_id, before_signature, page, signatures_discovered, transactions_fetched, status, pool_tier, updated_at FROM backfill_checkpoints WHERE checkpoint_key = ?").get(checkpointKey) as Record<string, unknown> | undefined;
    if (!row || typeof row.checkpoint_key !== "string" || typeof row.window_key !== "string" || typeof row.program_id !== "string" || typeof row.page !== "number" || typeof row.signatures_discovered !== "number" || typeof row.transactions_fetched !== "number" || typeof row.status !== "string" || typeof row.pool_tier !== "number" || typeof row.updated_at !== "string") return null;
    return {
      checkpointKey: row.checkpoint_key,
      windowKey: row.window_key,
      programId: row.program_id,
      beforeSignature: typeof row.before_signature === "string" ? row.before_signature : null,
      page: row.page,
      signaturesDiscovered: row.signatures_discovered,
      transactionsFetched: row.transactions_fetched,
      status: row.status === "COMPLETE" || row.status === "FAILED" ? row.status : "RUNNING",
      poolTier: row.pool_tier,
      updatedAt: row.updated_at,
    };
  } catch {
    return null;
  }
}

export function persistBackfillSignatures(checkpointKey: string, signatures: BackfillSignature[]): { rows: number; error: string | null } {
  const db = getDatabase();
  if (!db || signatures.length === 0) return { rows: 0, error: db ? null : databaseError ?? "SQLite 不可用" };
  try {
    const insert = db.prepare("INSERT OR IGNORE INTO backfill_signatures (checkpoint_key, signature, slot, block_time, has_error) VALUES (?, ?, ?, ?, ?)");
    let rows = 0;
    for (const item of signatures) {
      const result = insert.run(checkpointKey, item.signature, item.slot, item.blockTime, item.err ? 1 : 0);
      rows += Number(result.changes ?? 0);
    }
    noteStorageWrites("backfill_signatures", rows);
    return { rows, error: null };
  } catch (error) {
    return { rows: 0, error: error instanceof Error ? error.message : "回补签名清单落库失败" };
  }
}

export function readBackfillSignatures(checkpointKey: string): BackfillSignature[] {
  const db = getDatabase();
  if (!db) return [];
  try {
    const rows = db.prepare("SELECT signature, slot, block_time, has_error FROM backfill_signatures WHERE checkpoint_key = ? ORDER BY slot DESC").all(checkpointKey) as Array<Record<string, unknown>>;
    return rows.flatMap((row) => typeof row.signature === "string" ? [{ signature: row.signature, slot: typeof row.slot === "number" ? row.slot : null, blockTime: typeof row.block_time === "number" ? row.block_time : null, err: row.has_error === 1 }] : []);
  } catch {
    return [];
  }
}

export type OfficialReconciliationRow = {
  poolId: string;
  officialAsOf: string | null;
  localAsOf: string | null;
  officialTvl: number | null;
  localTvl: number | null;
  officialVolume24h: number | null;
  localVolume24h: number | null;
  officialFee24h: number | null;
  localFee24h: number | null;
  volumeDifferencePct: number | null;
  feeDifferencePct: number | null;
  status: "READY" | "PARTIAL" | "FAILED" | "UNAVAILABLE";
  checkedAt: string;
};

export function persistOfficialReconciliation(rows: OfficialReconciliationRow[]): { rows: number; error: string | null } {
  const db = getDatabase();
  if (!db) return { rows: 0, error: databaseError ?? "SQLite 不可用" };
  try {
    const insert = db.prepare(`
      INSERT OR REPLACE INTO official_reconciliation
      (pool_id, official_as_of, local_as_of, official_tvl, local_tvl, official_volume_24h, local_volume_24h, official_fee_24h, local_fee_24h, volume_difference_pct, fee_difference_pct, status, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) insert.run(row.poolId, row.officialAsOf, row.localAsOf, row.officialTvl, row.localTvl, row.officialVolume24h, row.localVolume24h, row.officialFee24h, row.localFee24h, row.volumeDifferencePct, row.feeDifferencePct, row.status, row.checkedAt);
    noteStorageWrites("official_reconciliation", rows.length);
    return { rows: rows.length, error: null };
  } catch (error) {
    return { rows: 0, error: error instanceof Error ? error.message : "官方数据对账落库失败" };
  }
}

export function readOfficialReconciliation(): OfficialReconciliationRow[] {
  const db = getDatabase();
  if (!db) return [];
  try {
    const rows = db.prepare("SELECT pool_id, official_as_of, local_as_of, official_tvl, local_tvl, official_volume_24h, local_volume_24h, official_fee_24h, local_fee_24h, volume_difference_pct, fee_difference_pct, status, checked_at FROM official_reconciliation").all() as Array<Record<string, unknown>>;
    return rows.flatMap((row) => typeof row.pool_id === "string" && typeof row.checked_at === "string" ? [{
      poolId: row.pool_id,
      officialAsOf: typeof row.official_as_of === "string" ? row.official_as_of : null,
      localAsOf: typeof row.local_as_of === "string" ? row.local_as_of : null,
      officialTvl: typeof row.official_tvl === "number" ? row.official_tvl : null,
      localTvl: typeof row.local_tvl === "number" ? row.local_tvl : null,
      officialVolume24h: typeof row.official_volume_24h === "number" ? row.official_volume_24h : null,
      localVolume24h: typeof row.local_volume_24h === "number" ? row.local_volume_24h : null,
      officialFee24h: typeof row.official_fee_24h === "number" ? row.official_fee_24h : null,
      localFee24h: typeof row.local_fee_24h === "number" ? row.local_fee_24h : null,
      volumeDifferencePct: typeof row.volume_difference_pct === "number" ? row.volume_difference_pct : null,
      feeDifferencePct: typeof row.fee_difference_pct === "number" ? row.fee_difference_pct : null,
      status: row.status === "READY" || row.status === "FAILED" || row.status === "PARTIAL" ? row.status : "UNAVAILABLE",
      checkedAt: row.checked_at,
    } satisfies OfficialReconciliationRow] : []);
  } catch {
    return [];
  }
}
