import path from "node:path";
import { existsSync } from "node:fs";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { MarketProjectionEnvelopeSchema, RankingQuerySchema, WalletRequestSchema, normalizeNullSemantics } from "@lp-alpha/shared-types";
import { getProjectedRanking, readMarketProjection, type MarketProjection } from "@/services/projection/market";
import { checkEventDatabaseIntegrity, getStorageMetricsSnapshot, readBackfillFailures, readBackfillJob, readBackfillPoolCursors, readIndexerState, readSwitchSignals } from "@/services/storage/event-index";
import { RAW_BACKFILL_JOB_ID } from "@/services/indexer/progress";
import { getConfiguredReadOnlyAddress, removeReadOnlyAddress, saveReadOnlyAddress } from "@/services/wallet/config";

const port = Math.max(1, Number(process.env.LP_BACKEND_PORT ?? process.env.LP_PORT ?? 3838));
const host = process.env.LP_ENABLE_LAN === "1" ? "0.0.0.0" : (process.env.LP_HOST ?? "127.0.0.1");
const projectRoot = process.cwd();
const frontendRoot = path.join(projectRoot, "apps", "frontend", "dist");

function unavailable(reply: { code: (status: number) => { send: (payload: unknown) => unknown } }, reason: string) {
  return reply.code(503).send(normalizeNullSemantics({ status: "WAITING_PROJECTION", reason, snapshot: null }));
}

function currentProjection(): MarketProjection | null {
  return readMarketProjection();
}

function projectionEnvelope(projection: MarketProjection) {
  const envelope = normalizeNullSemantics(projection);
  const parsed = MarketProjectionEnvelopeSchema.safeParse(envelope);
  return parsed.success ? envelope : normalizeNullSemantics({ ...projection, validation: "PROJECTION_SCHEMA_WARNING" });
}

function requestOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  if (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")) return true;
  if (process.env.LP_ENABLE_LAN === "1" && /^http:\/\/192\.168\.|^http:\/\/10\.|^http:\/\/172\.(1[6-9]|2\d|3[0-1])\./.test(origin)) return true;
  return false;
}

const app = Fastify({
  logger: false,
  bodyLimit: 256 * 1024,
});

const startupIntegrity = checkEventDatabaseIntegrity();
if (!startupIntegrity.ok) throw new Error(`SQLite 启动完整性检查失败：${startupIntegrity.detail}`);

await app.register(cors, {
  origin: (origin, callback) => callback(null, requestOriginAllowed(origin)),
  credentials: false,
});
await app.register(fastifyWebsocket);
if (existsSync(frontendRoot)) await app.register(fastifyStatic, { root: frontendRoot, wildcard: false, index: false });

app.addHook("onRequest", async (request, reply) => {
  if (!requestOriginAllowed(request.headers.origin)) {
    await reply.code(403).send({ error: "Origin 不在本地终端允许范围内" });
  }
});

app.get("/api/market/snapshot", async (_request, reply) => {
  const projection = currentProjection();
  if (!projection) return unavailable(reply, "等待 metrics worker 写入 MarketProjection");
  return reply.header("cache-control", "no-store").send(projectionEnvelope(projection));
});

app.get("/api/rankings", async (request, reply) => {
  const parsed = RankingQuerySchema.safeParse({
    capital: (request.query as Record<string, unknown>).capital ?? "1000",
    window: (request.query as Record<string, unknown>).window ?? "24h",
  });
  if (!parsed.success) return reply.code(400).send({ error: "capital 或 window 参数无效", details: parsed.error.flatten() });
  const projection = currentProjection();
  if (!projection) return unavailable(reply, "等待 metrics worker 写入排名投影");
  const capital = Number(parsed.data.capital) as 1_000 | 10_000;
  const ranking = getProjectedRanking(projection, capital, parsed.data.window);
  return reply.header("cache-control", "no-store").header("x-data-version", String(projection.projectionVersion)).send(normalizeNullSemantics(ranking));
});

app.get("/api/health", async (_request, reply) => {
  const projection = currentProjection();
  const integrity = checkEventDatabaseIntegrity();
  const snapshot = projection?.snapshot ?? null;
  const health = normalizeNullSemantics({
    status: snapshot?.status ?? "LIVE_RWA_DATA_PARTIAL",
    network: "Solana Mainnet",
    runtime: {
      backend: "FASTIFY",
      frontend: existsSync(frontendRoot) ? "VITE_STATIC" : "VITE_NOT_BUILT",
      process: process.pid,
      host,
      port,
    },
    projection: projection ? { version: projection.projectionVersion, updatedAt: projection.updatedAt, sourceTimestamp: projection.sourceTimestamp } : { version: null, updatedAt: null, sourceTimestamp: null },
    architectureStatus: {
      ARCHITECTURE_MIGRATION_READY: integrity.ok && existsSync(frontendRoot),
      MARKET_PROJECTION_READY: projection !== null,
      SHORT_WINDOW_ANALYTICS_READY: snapshot?.statusReport?.SHORT_WINDOW_ANALYTICS_STATUS === "SHORT_WINDOW_ANALYTICS_READY",
      RANKING_ENGINE_READY: projection !== null,
      SWITCH_SIGNAL_READY: true,
      LOCAL_RUNTIME_READY: true,
      IPAD_READY: existsSync(frontendRoot),
    },
    publicMarket: snapshot?.publicMarket ?? null,
    statusReport: snapshot?.statusReport ?? null,
    discovery: snapshot?.discovery ?? null,
    swapIndexer: snapshot?.swapIndexer ?? null,
    diagnostics: {
      stream: readIndexerState("stream.status"),
      metrics: readIndexerState("metrics.public"),
      workerLifecycle: {
        indexer: readIndexerState("worker.lifecycle.indexer"),
        backfill: readIndexerState("worker.lifecycle.backfill"),
        metrics: readIndexerState("worker.lifecycle.metrics"),
      },
      storage: getStorageMetricsSnapshot(),
      database: integrity,
      switchSignals: readSwitchSignals(100),
    },
  });
  return reply.header("cache-control", "no-store").send(health);
});

app.get("/api/signals", async (_request, reply) => reply.header("cache-control", "no-store").send(normalizeNullSemantics({ signals: readSwitchSignals(200) })));

app.get("/api/backfill", async (_request, reply) => {
  return reply.header("cache-control", "no-store").send(normalizeNullSemantics({
    job: readBackfillJob(RAW_BACKFILL_JOB_ID),
    cursors: readBackfillPoolCursors(RAW_BACKFILL_JOB_ID),
    failures: readBackfillFailures(RAW_BACKFILL_JOB_ID, 100),
    progress: readIndexerState("backfill.progress"),
    universe: readIndexerState("backfill.universe"),
  }));
});

function walletPayload(snapshot: MarketProjection["snapshot"] | null) {
  const address = getConfiguredReadOnlyAddress();
  return {
    configured: Boolean(address),
    address,
    readOnly: true,
    positionCount: snapshot?.positions.length ?? 0,
    scannedAt: snapshot?.generatedAt ?? null,
    scanning: false,
  };
}

app.get("/api/wallet", async (_request, reply) => reply.header("cache-control", "no-store").send(normalizeNullSemantics({ wallet: walletPayload(currentProjection()?.snapshot ?? null) })));

app.post("/api/wallet", async (request, reply) => {
  const parsed = WalletRequestSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "请求格式无效" });
  const saved = saveReadOnlyAddress(parsed.data.address);
  if ("error" in saved) return reply.code(400).send({ error: saved.error });
  const projection = currentProjection();
  return reply.code(202).header("cache-control", "no-store").send(normalizeNullSemantics({ wallet: { ...walletPayload(projection?.snapshot ?? null), configured: true, address: saved.address, scanning: true }, snapshot: projection?.snapshot ?? null, reason: "后台 worker 将在下一轮扫描只读仓位" }));
});

app.delete("/api/wallet", async (_request, reply) => {
  removeReadOnlyAddress();
  const projection = currentProjection();
  return reply.header("cache-control", "no-store").send(normalizeNullSemantics({ wallet: walletPayload(null), snapshot: projection?.snapshot ?? null }));
});

app.post("/api/wallet/rescan", async (_request, reply) => {
  if (!getConfiguredReadOnlyAddress()) return reply.code(400).send({ error: "尚未添加只读钱包地址" });
  return reply.code(202).send(normalizeNullSemantics({ wallet: walletPayload(currentProjection()?.snapshot ?? null), reason: "扫描由后台 worker 执行；页面不会阻塞" }));
});

app.get("/api/stream", async (_request, reply) => {
  const projection = currentProjection();
  if (!projection) return unavailable(reply, "等待 MarketProjection");
  return reply.header("cache-control", "no-store").send(normalizeNullSemantics({ event: "market.snapshot", projectionVersion: projection.projectionVersion, payload: projection }));
});

app.get("/stream", { websocket: true }, (socket) => {
  let lastVersion = -1;
  const sendProjection = () => {
    const projection = currentProjection();
    if (!projection || projection.projectionVersion <= lastVersion) return;
    lastVersion = projection.projectionVersion;
    socket.send(JSON.stringify(normalizeNullSemantics({ event: "market.snapshot", projectionVersion: projection.projectionVersion, payload: projection })));
  };
  sendProjection();
  const timer = setInterval(sendProjection, 1_000);
  socket.on("close", () => clearInterval(timer));
  socket.on("error", () => clearInterval(timer));
});

app.get("/", async (_request, reply) => {
  if (!existsSync(path.join(frontendRoot, "index.html"))) return reply.type("text/plain; charset=utf-8").send("Frontend 尚未构建，请运行 npm run build:frontend");
  return reply.sendFile("index.html");
});

app.setNotFoundHandler(async (request, reply) => {
  if (request.method === "GET" && existsSync(path.join(frontendRoot, "index.html"))) return reply.sendFile("index.html");
  return reply.code(404).send({ error: "Not Found" });
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const forceExit = setTimeout(() => process.exit(1), 3_000);
  forceExit.unref();
  void app.close().finally(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  await app.listen({ port, host });
  console.log(`[backend] Fastify ready http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
