import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

function run(dbPath, migrationsPath) {
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", "import { checkEventDatabaseIntegrity } from \"@/services/storage/event-index\"; const result=checkEventDatabaseIntegrity(); console.log(JSON.stringify(result)); if (!result.ok) process.exit(2);"], {
    cwd: root,
    env: { ...process.env, LP_EVENT_DB_PATH: dbPath, LP_MIGRATIONS_DIR: migrationsPath },
    encoding: "utf8",
  });
}

test("migration checksum rejects edits after application and SQLite uses WAL", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "lp-alpha-migrations-"));
  const migrations = path.join(temp, "migrations");
  const db = path.join(temp, "facts.sqlite");
  const sourceMigration = path.join(root, "migrations/0001_architecture_runtime.sql");
  cpSync(path.dirname(sourceMigration), migrations, { recursive: true });
  const first = run(db, migrations);
  assert.equal(first.status, 0, first.stderr);
  const altered = readFileSync(sourceMigration, "utf8") + "\n-- altered after application\n";
  writeFileSync(path.join(migrations, "0001_architecture_runtime.sql"), altered, "utf8");
  const second = run(db, migrations);
  assert.notEqual(second.status, 0);
  assert.match(`${second.stdout}\n${second.stderr}`, /迁移校验和不匹配/);
  rmSync(temp, { recursive: true, force: true });
});
