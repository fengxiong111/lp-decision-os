import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { checkEventDatabaseIntegrity } from "@/services/storage/event-index";

const root = process.cwd();
const port = Number(process.env.LP_BACKEND_PORT ?? process.env.LP_PORT ?? 3838);
const checks: Record<string, unknown> = {
  node: process.versions.node,
  nodeMajor: Number(process.versions.node.split(".")[0]),
  frontendBuild: existsSync(path.join(root, "apps/frontend/dist/index.html")),
  database: checkEventDatabaseIntegrity(),
  databasePath: process.env.LP_EVENT_DB_PATH ?? (existsSync(path.join(root, ".local-data/lp-events.sqlite")) ? path.join(root, ".local-data/lp-events.sqlite") : path.join(root, "db/lp-events.sqlite")),
  port,
  portListening: false,
};

try {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) });
  checks.portListening = response.ok;
  checks.healthStatus = response.status;
} catch (error) {
  checks.healthError = error instanceof Error ? error.message : "health 不可访问";
}

if (process.argv.includes("--database")) {
  checks.databaseFileBytes = (() => {
    try { return statSync(String(checks.databasePath)).size; } catch { return null; }
  })();
}

console.log(JSON.stringify(checks, null, 2));
const databaseOkay = Boolean((checks.database as { ok?: boolean }).ok);
if (checks.nodeMajor !== 22 && checks.nodeMajor !== 23 && checks.nodeMajor !== 24 && checks.nodeMajor !== 25) process.exitCode = 1;
if (!databaseOkay) process.exitCode = 1;

