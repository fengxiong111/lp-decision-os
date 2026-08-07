import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fetchPoolKeys } from "@/services/raydium/keys";
import { readRpcTransactionCache } from "@/services/storage/event-index";

const targets = [
  {
    id: "FjuBy7jjf9DXj9d3R7cHpvcnoFW2iQxf7F7P3vqx4Jza",
    symbol: "SPCX",
    assetMint: "SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb",
    feeRate: 0.0025,
    vaultA: "2iM4Qur7sY2cPWRvfDjQbw2u7WZuHVgWicGGaMoYjJn8",
    vaultB: "FqRgdh1hE1YggkMRDvyf3HRpceUqoBdBTwmRHieiz2Kt",
  },
  {
    id: "AHNN6JmvaGG6XUoSg7sEr38gRYDB2jTbUvqXVuqaRHpq",
    symbol: "SPCXx",
    assetMint: "Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8",
    feeRate: 0.008,
    vaultA: "2wmq9LoqAjyKr5YkenAkGozA7xZvbfrCqJXFUuyQHYoa",
    vaultB: "AUpEZuNEZfqUXqsoiTymSEwiRXwT67Vvr1bnBqyQSzNv",
  },
] as const;

const sqliteLoader = (process as NodeJS.Process & { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;

async function main(): Promise<void> {
  const sqlite = sqliteLoader?.("node:sqlite") as unknown as { DatabaseSync: new (file: string) => { prepare: (sql: string) => { all: () => Array<Record<string, unknown>> } } } | undefined;
  if (!sqlite?.DatabaseSync) throw new Error("node:sqlite 不可用");
  const databasePath = process.env.LP_EVENT_DB_PATH ?? path.join(process.cwd(), ".local-data", "lp-events.sqlite");
  const db = new sqlite.DatabaseSync(databasePath);
  const rows = db.prepare("SELECT pool_address,signature,slot,block_time,input_mint,output_mint,amount_in,amount_out,volume_usd,lp_fee_usd FROM normalized_swaps WHERE parse_version = 'raydium-swap-parser-v2' ORDER BY block_time DESC").all();
  const selected = targets.flatMap((target) => rows.filter((row) => row.pool_address === target.id).slice(0, 20).map((row) => ({ target, row })));
  if (selected.filter((item) => item.target.symbol === "SPCX").length < 20 || selected.filter((item) => item.target.symbol === "SPCXx").length < 20) {
    throw new Error("真实夹具不足：每个目标 Pool 必须至少有 20 笔已解析交易");
  }
  const cache = readRpcTransactionCache(selected.map((item) => String(item.row.signature)));
  const keyResult = await fetchPoolKeys(targets.map((target) => target.id));
  const fixtures = selected.flatMap(({ target, row }) => {
    const cached = cache.get(String(row.signature));
    if (!cached?.payload || cached.status !== "SUCCESS") return [];
    const keys = keyResult.keys.get(target.id);
    return [{
      signature: String(row.signature),
      source: "real cached Solana RPC getTransaction",
      expected: {
        poolAddress: target.id,
        programId: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
        baseMint: target.assetMint,
        quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        inputMint: String(row.input_mint),
        outputMint: String(row.output_mint),
        amountInAtomic: String(row.amount_in),
        amountOutAtomic: String(row.amount_out),
        volumeUsd: Number(row.volume_usd),
        feeStatus: row.lp_fee_usd === null ? "FEE_UNAVAILABLE" : "FIXED_POOL_RATE",
        feeUsd: row.lp_fee_usd === null ? null : Number(row.lp_fee_usd),
      },
      pool: {
        id: target.id,
        programId: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
        poolKind: "CLMM",
        vaultA: keys?.vaultA ?? target.vaultA,
        vaultB: keys?.vaultB ?? target.vaultB,
        assetMint: target.assetMint,
        quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        currentPrice: 1,
        feeRate: target.feeRate,
        hasDynamicFee: false,
      },
      transaction: cached.payload,
    }];
  });
  const targetDirectory = path.join(process.cwd(), "tests", "fixtures", "solana-transactions");
  mkdirSync(targetDirectory, { recursive: true });
  writeFileSync(path.join(targetDirectory, "raydium-recovery-real.json"), JSON.stringify({ generatedAt: new Date().toISOString(), fixtureCount: fixtures.length, fixtures }, null, 2), "utf8");
  console.log(JSON.stringify({ fixtureCount: fixtures.length, byPool: Object.fromEntries(targets.map((target) => [target.symbol, fixtures.filter((item) => item.expected.poolAddress === target.id).length])), keyError: keyResult.error }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
