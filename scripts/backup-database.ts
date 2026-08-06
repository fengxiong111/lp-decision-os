import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const loader = process.getBuiltinModule;
const { DatabaseSync } = loader("node:sqlite") as typeof import("node:sqlite");
const root = process.cwd();
const targetArg = process.argv.indexOf("--target");
const target = targetArg >= 0 && process.argv[targetArg + 1]
  ? path.resolve(process.argv[targetArg + 1])
  : path.join(root, ".local-data", "backups", new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-"));
mkdirSync(target, { recursive: true });

for (const relative of [".local-data/lp-events.sqlite", ".local-data/rpc-governor.sqlite"]) {
  const source = path.join(root, relative);
  if (!existsSync(source)) continue;
  const destination = path.join(target, path.basename(source));
  const db = new DatabaseSync(source);
  db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  const escaped = destination.replaceAll("'", "''");
  db.exec("VACUUM INTO '" + escaped + "'");
  db.close();
}

const wallet = path.join(root, ".local-data/read-only-wallet.json");
if (existsSync(wallet)) copyFileSync(wallet, path.join(target, "read-only-wallet.json"));
console.log(JSON.stringify({ backupDir: target }, null, 2));

