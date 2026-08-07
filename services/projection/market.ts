import { MarketProjectionEnvelopeSchema, normalizeNullSemantics } from "@lp-alpha/shared-types";
import { CAPITAL_OPTIONS, type DashboardSnapshot } from "@/packages/models/src";
import { buildRankingResponse, type RankingResponse, type TerminalWindow } from "@/services/rankings";
import { refreshSwitchSignals } from "@/services/signals/refresh";
import { persistIndexerState, persistMarketProjection, readIndexerState, readLatestMarketProjection, type StoredMarketProjection } from "@/services/storage/event-index";

export const MARKET_PROJECTION_STATE_KEY = "market.projection";
export const MARKET_PROJECTION_VERSION_KEY = "market.projection.version";
export const PROJECTION_WINDOWS: TerminalWindow[] = ["1h", "6h", "12h", "24h"];

export type MarketProjection = {
  projectionVersion: number;
  source: "market-projection";
  sourceTimestamp: string;
  receivedAt: string;
  updatedAt: string;
  snapshot: DashboardSnapshot;
  rankings: Record<string, Record<TerminalWindow, RankingResponse>>;
  sourceHealth: {
    publicMarket: DashboardSnapshot["publicMarket"];
    rpc: DashboardSnapshot["rpc"];
    websocket: DashboardSnapshot["websocket"];
    swapIndexer: DashboardSnapshot["swapIndexer"];
  };
};

function sourceHealth(snapshot: DashboardSnapshot): MarketProjection["sourceHealth"] {
  return {
    publicMarket: snapshot.publicMarket,
    rpc: snapshot.rpc,
    websocket: snapshot.websocket,
    swapIndexer: snapshot.swapIndexer,
  };
}

function rankingMap(snapshot: DashboardSnapshot): Record<string, Record<TerminalWindow, RankingResponse>> {
  return Object.fromEntries(CAPITAL_OPTIONS.map((capital) => [
    String(capital), Object.fromEntries(PROJECTION_WINDOWS.map((window) => [window, buildRankingResponse(snapshot, capital, window)])) as Record<TerminalWindow, RankingResponse>,
  ])) as Record<string, Record<TerminalWindow, RankingResponse>>;
}

function nextProjectionVersion(): number {
  const stored = readLatestMarketProjection()?.projectionVersion ?? 0;
  const state = readIndexerState<{ projectionVersion?: number }>(MARKET_PROJECTION_VERSION_KEY)?.projectionVersion ?? 0;
  return Math.max(stored, state) + 1;
}

export function createMarketProjection(snapshot: DashboardSnapshot, projectionVersion = nextProjectionVersion(), receivedAt = new Date().toISOString()): MarketProjection {
  const updatedAt = snapshot.generatedAt;
  const sourceTimestamp = snapshot.discovery.apiObservedAt ?? snapshot.generatedAt;
  return normalizeNullSemantics({
    projectionVersion,
    source: "market-projection" as const,
    sourceTimestamp,
    receivedAt,
    updatedAt,
    snapshot,
    rankings: rankingMap(snapshot),
    sourceHealth: sourceHealth(snapshot),
  }) as MarketProjection;
}

export function acceptsProjectionUpdate(current: Pick<MarketProjection, "sourceTimestamp" | "projectionVersion"> | null, candidate: Pick<MarketProjection, "sourceTimestamp" | "projectionVersion">): boolean {
  if (!current) return true;
  const currentTime = Date.parse(current.sourceTimestamp);
  const candidateTime = Date.parse(candidate.sourceTimestamp);
  if (Number.isFinite(currentTime) && Number.isFinite(candidateTime) && candidateTime < currentTime) return false;
  return candidate.projectionVersion > current.projectionVersion;
}

export function publishMarketProjection(snapshot: DashboardSnapshot): MarketProjection {
  const projection = createMarketProjection(snapshot);
  const current = readMarketProjection();
  if (!acceptsProjectionUpdate(current, projection)) return current ?? projection;
  const stored = persistMarketProjection({
    projectionVersion: projection.projectionVersion,
    sourceTimestamp: projection.sourceTimestamp,
    receivedAt: projection.receivedAt,
    snapshot: projection.snapshot,
    rankings: projection.rankings,
    sourceHealth: projection.sourceHealth,
  });
  if (stored.error) throw new Error(stored.error);
  persistIndexerState(MARKET_PROJECTION_STATE_KEY, projection);
  persistIndexerState(MARKET_PROJECTION_VERSION_KEY, { projectionVersion: projection.projectionVersion, updatedAt: projection.updatedAt });
  refreshSwitchSignals(projection);
  return projection;
}

function decodeStoredProjection(stored: StoredMarketProjection): MarketProjection | null {
  const candidate = normalizeNullSemantics({
    projectionVersion: stored.projectionVersion,
    source: "market-projection",
    sourceTimestamp: stored.sourceTimestamp,
    receivedAt: stored.receivedAt,
    updatedAt: stored.createdAt,
    snapshot: stored.snapshot,
    rankings: stored.rankings,
    sourceHealth: stored.sourceHealth,
  });
  const parsed = MarketProjectionEnvelopeSchema.safeParse(candidate);
  if (!parsed.success) return null;
  return candidate as MarketProjection;
}

function fallbackProjection(): MarketProjection | null {
  const snapshot = readIndexerState<DashboardSnapshot>("last_known_good_snapshot");
  if (!snapshot?.pools?.length) return null;
  const version = readIndexerState<{ projectionVersion?: number }>(MARKET_PROJECTION_VERSION_KEY)?.projectionVersion ?? 0;
  return createMarketProjection(snapshot, version, snapshot.generatedAt);
}

export function readMarketProjection(): MarketProjection | null {
  const stored = readLatestMarketProjection();
  if (stored) return decodeStoredProjection(stored);
  const state = readIndexerState<MarketProjection>(MARKET_PROJECTION_STATE_KEY);
  if (state) {
    const parsed = MarketProjectionEnvelopeSchema.safeParse(normalizeNullSemantics(state));
    if (parsed.success) return state;
  }
  return fallbackProjection();
}

export function getProjectedRanking(projection: MarketProjection, capital: 1_000 | 10_000, window: TerminalWindow, includeOfficialOnly = false): RankingResponse {
  if (includeOfficialOnly) return buildRankingResponse(projection.snapshot, capital, window, { includeOfficialOnly: true });
  const stored = projection.rankings[String(capital)]?.[window];
  return stored ?? buildRankingResponse(projection.snapshot, capital, window);
}
