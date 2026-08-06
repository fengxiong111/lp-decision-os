import { WINDOW_KEYS, type EventWindowCoverage, type MinuteBucket, type PersistedPoolMetricState, type RouteShareMetric, type SwapEventRecord, type WindowKey, type WindowMetric } from "@/packages/models/src";

export const WINDOW_SECONDS: Record<WindowKey, number> = {
  "1m": 60,
  "5m": 5 * 60,
  "30m": 30 * 60,
  "1h": 60 * 60,
  "6h": 6 * 60 * 60,
  "12h": 12 * 60 * 60,
  "24h": 24 * 60 * 60,
};

function floorMinute(value: string | Date): Date {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  date.setUTCSeconds(0, 0);
  return date;
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sum(values: Array<number | null | undefined>): number {
  return values.reduce<number>((total, value) => total + (typeof value === "number" && Number.isFinite(value) ? value : 0), 0);
}

function sumKnown(values: Array<number | null | undefined>): number | null {
  const known = values.filter(finite);
  if (values.length === 0 || known.length !== values.length) return null;
  return known.reduce((total, value) => total + value, 0);
}

function percentDifference(numerator: number | null, denominator: number | null): number | null {
  if (!finite(numerator) || !finite(denominator) || denominator === 0) return null;
  return Math.abs((numerator - denominator) / denominator) * 100;
}

export function bucketStartFor(value: string | Date): string {
  return floorMinute(value).toISOString();
}

export function buildMinuteBuckets(events: SwapEventRecord[], asOf: string, status: MinuteBucket["status"] = "COMPLETE", quoteMints: Map<string, string> = new Map()): MinuteBucket[] {
  const grouped = new Map<string, SwapEventRecord[]>();
  for (const event of events) {
    const key = `${event.poolId}:${bucketStartFor(event.blockTime)}`;
    const group = grouped.get(key) ?? [];
    group.push(event);
    grouped.set(key, group);
  }
  return [...grouped.values()].flatMap((group) => {
    const first = group[0];
    if (!first) return [];
    const bucketStart = bucketStartFor(first.blockTime);
    const quoteMint = quoteMints.get(first.poolId) ?? null;
    const buyVolumeUsd = sum(group.map((event) => event.inputMint && quoteMint && event.inputMint === quoteMint ? event.volume : null));
    const knownBuySell = group.some((event) => event.inputMint !== null);
    const sellVolumeUsd = knownBuySell ? sum(group.map((event) => event.inputMint && quoteMint && event.inputMint !== quoteMint ? event.volume : null)) : 0;
    const feeKnown = group.every((event) => finite(event.feeUsd) && event.lpFeeAtomic !== null);
    const feeUsd = feeKnown ? sum(group.map((event) => event.feeUsd)) : null;
    const tvl = null;
    return [{
      poolId: first.poolId,
      bucketStart,
      volumeUsd: sum(group.map((event) => event.volume)),
      grossFeeUsd: feeUsd,
      lpFeeUsd: feeUsd,
      swapCount: group.length,
      buyVolumeUsd,
      sellVolumeUsd,
      uniqueWalletCount: new Set(group.flatMap((event) => event.trader ? [event.trader] : [])).size || null,
      tvlStart: tvl,
      tvlEnd: tvl,
      activeTvl: tvl,
      feeDensity: null,
      liquidityVelocity: null,
      coverageRatio: status === "COMPLETE" || status === "LIVE" ? 100 : null,
      status,
      source: [...new Set(group.map((event) => event.source))].join(" + "),
      asOf,
    } satisfies MinuteBucket];
  });
}

function unavailableMetric(window: WindowKey, coverage: EventWindowCoverage, reason: string): WindowMetric {
  return {
    window,
    volume: null,
    fee: null,
    grossFeeUsd: null,
    lpFeeUsd: null,
    swapCount: null,
    buyVolumeUsd: null,
    sellVolumeUsd: null,
    uniqueWalletCount: null,
    tvlStart: null,
    tvlEnd: null,
    activeTvl: null,
    feeDensity: null,
    liquidityVelocity: null,
    routeShare: null,
    coverageRatio: coverage.coverageRatio,
    status: coverage.backfillStatus,
    firstEventAt: coverage.firstEventAt,
    lastEventAt: coverage.lastEventAt,
    asOf: coverage.windowEnd,
    apr: null,
    source: "unavailable",
    sourceLabel: reason,
    observedAt: coverage.windowEnd,
    available: false,
  };
}

function coverageForWindow(window: WindowKey, buckets: MinuteBucket[], asOf: Date, sourceCoverage: EventWindowCoverage | null): EventWindowCoverage {
  const expected = Math.max(1, Math.ceil(WINDOW_SECONDS[window] / 60));
  const end = floorMinute(asOf);
  const start = new Date(end.getTime() - WINDOW_SECONDS[window] * 1000);
  const selected = buckets.filter((bucket) => {
    const time = Date.parse(bucket.bucketStart);
    return time >= start.getTime() && time < end.getTime();
  });
  const starts = new Set(selected.map((bucket) => bucket.bucketStart));
  let observed = 0;
  for (let index = 0; index < expected; index += 1) {
    const expectedStart = new Date(end.getTime() - (index + 1) * 60_000).toISOString();
    if (starts.has(expectedStart)) observed += 1;
  }
  const contiguous = observed === expected;
  const base = sourceCoverage ?? {
    eventCount: selected.reduce((total, bucket) => total + bucket.swapCount, 0),
    poolCount: selected.length > 0 ? 1 : 0,
    firstSlot: null,
    lastSlot: null,
    firstEventAt: selected.at(-1)?.bucketStart ?? null,
    lastEventAt: selected[0]?.bucketStart ?? null,
    completeness: null,
    persisted: selected.length > 0,
    source: "minute_buckets",
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    startSlot: null,
    endSlot: null,
    expectedSlotRange: null,
    signaturesDiscovered: selected.reduce((total, bucket) => total + bucket.swapCount, 0),
    transactionsFetched: selected.reduce((total, bucket) => total + bucket.swapCount, 0),
    transactionsSuccessful: selected.reduce((total, bucket) => total + bucket.swapCount, 0),
    transactionsFailed: 0,
    swapsParsed: selected.reduce((total, bucket) => total + bucket.swapCount, 0),
    swapsRejected: 0,
    duplicatesRemoved: 0,
    unknownInstructions: 0,
    gapSlots: contiguous ? 0 : null,
    coverageRatio: (observed / expected) * 100,
    firstEventTime: selected.at(-1)?.bucketStart ?? null,
    lastEventTime: selected[0]?.bucketStart ?? null,
    backfillStatus: contiguous ? "COMPLETE" as const : selected.length > 0 ? "PARTIAL" as const : "UNAVAILABLE" as const,
  } satisfies EventWindowCoverage;
  const complete = contiguous && (base.backfillStatus === "COMPLETE" || base.backfillStatus === "LIVE") && base.gapSlots === 0 && base.unknownInstructions === 0;
  return {
    ...base,
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    eventCount: selected.reduce((total, bucket) => total + bucket.swapCount, 0),
    swapsParsed: selected.reduce((total, bucket) => total + bucket.swapCount, 0),
    coverageRatio: base.coverageRatio ?? (observed / expected) * 100,
    backfillStatus: complete ? base.backfillStatus : base.backfillStatus === "BACKFILLING" || base.backfillStatus === "RUNNING" ? base.backfillStatus : selected.length > 0 ? "PARTIAL" : "UNAVAILABLE",
    gapSlots: complete ? 0 : base.gapSlots,
  };
}

function metricForWindow(window: WindowKey, buckets: MinuteBucket[], asOf: Date, sourceCoverage: EventWindowCoverage | null, fallbackTvl: number | null): { metric: WindowMetric; coverage: EventWindowCoverage } {
  const coverage = coverageForWindow(window, buckets, asOf, sourceCoverage);
  const end = floorMinute(asOf);
  const start = new Date(end.getTime() - WINDOW_SECONDS[window] * 1000);
  const selected = buckets.filter((bucket) => {
    const time = Date.parse(bucket.bucketStart);
    return time >= start.getTime() && time < end.getTime();
  }).sort((a, b) => a.bucketStart.localeCompare(b.bucketStart));
  if (selected.length === 0) return { metric: unavailableMetric(window, coverage, "等待已落库 1 分钟桶"), coverage };
  const volume = sum(selected.map((bucket) => bucket.volumeUsd));
  const allFeeKnown = selected.every((bucket) => bucket.lpFeeUsd !== null);
  const lpFeeUsd = allFeeKnown ? sum(selected.map((bucket) => bucket.lpFeeUsd)) : null;
  const grossFeeUsd = selected.every((bucket) => bucket.grossFeeUsd !== null) ? sum(selected.map((bucket) => bucket.grossFeeUsd)) : null;
  const tvlStart = selected.find((bucket) => finite(bucket.tvlStart))?.tvlStart ?? fallbackTvl;
  const tvlEnd = [...selected].reverse().find((bucket) => finite(bucket.tvlEnd))?.tvlEnd ?? fallbackTvl;
  const activeTvl = selected.find((bucket) => finite(bucket.activeTvl))?.activeTvl ?? fallbackTvl;
  const avgTvl = finite(tvlStart) && finite(tvlEnd) ? (tvlStart + tvlEnd) / 2 : activeTvl;
  const complete = (coverage.backfillStatus === "COMPLETE" || coverage.backfillStatus === "LIVE") && coverage.coverageRatio === 100 && coverage.gapSlots === 0 && coverage.unknownInstructions === 0;
  const metric: WindowMetric = {
    window,
    volume,
    fee: lpFeeUsd,
    grossFeeUsd,
    lpFeeUsd,
    swapCount: selected.reduce((total, bucket) => total + bucket.swapCount, 0),
    buyVolumeUsd: sumKnown(selected.map((bucket) => bucket.buyVolumeUsd)),
    sellVolumeUsd: sumKnown(selected.map((bucket) => bucket.sellVolumeUsd)),
    uniqueWalletCount: sumKnown(selected.map((bucket) => bucket.uniqueWalletCount)),
    tvlStart,
    tvlEnd,
    activeTvl,
    feeDensity: lpFeeUsd !== null && finite(avgTvl) && avgTvl > 0 ? (lpFeeUsd / avgTvl) * 100 : null,
    liquidityVelocity: finite(avgTvl) && avgTvl > 0 ? volume / avgTvl : null,
    routeShare: null,
    coverageRatio: coverage.coverageRatio,
    status: coverage.backfillStatus,
    firstEventAt: coverage.firstEventAt,
    lastEventAt: coverage.lastEventAt,
    asOf: coverage.windowEnd,
    apr: lpFeeUsd !== null && finite(avgTvl) && avgTvl > 0 ? (lpFeeUsd / avgTvl) * (365 * 24 * 60 * 60 / WINDOW_SECONDS[window]) * 100 : null,
    source: complete ? "event-index" : "unavailable",
    sourceLabel: complete ? "1 分钟桶 → UTC 窗口聚合" : `等待 ${window} 回补：${coverage.backfillStatus}`,
    observedAt: coverage.windowEnd,
    // A complete window with no swaps is a measured zero, not missing data.
    available: complete,
  };
  return { metric, coverage };
}

function emptyRouteShare(window: WindowKey, pairPoolCount: number, asOf: string): RouteShareMetric {
  return { share: null, pairPoolCount, windowActivePoolCount: 0, denominatorVolume: null, poolVolume: null, unattributedVolume: null, source: "minute_buckets", observedAt: asOf };
}

export function buildPersistedPoolMetrics(input: {
  pools: Array<{ id: string; pairKey: string; tvl: number | null; effectiveActiveTvl: number | null }>;
  buckets: MinuteBucket[];
  eventsByPool: Map<string, SwapEventRecord[]>;
  sourceCoverage: Record<string, Record<WindowKey, EventWindowCoverage>>;
  asOf: string;
}): { pools: Record<string, PersistedPoolMetricState>; windows: Record<WindowKey, EventWindowCoverage> } {
  const asOfDate = new Date(input.asOf);
  const poolStates = new Map<string, { state: PersistedPoolMetricState; pairKey: string }>();
  const globalWindows = Object.fromEntries(WINDOW_KEYS.map((key) => [key, {
    eventCount: 0,
    poolCount: 0,
    firstSlot: null,
    lastSlot: null,
    firstEventAt: null,
    lastEventAt: null,
    completeness: null,
    persisted: false,
    source: "indexer-worker",
    windowStart: new Date(asOfDate.getTime() - WINDOW_SECONDS[key] * 1000).toISOString(),
    windowEnd: input.asOf,
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
    backfillStatus: "UNAVAILABLE" as const,
  } satisfies EventWindowCoverage])) as Record<WindowKey, EventWindowCoverage>;
  for (const pool of input.pools) {
    const poolBuckets = input.buckets.filter((bucket) => bucket.poolId === pool.id);
    const sourceCoverage = input.sourceCoverage[pool.id] ?? {} as Record<WindowKey, EventWindowCoverage>;
    const windows = {} as Record<WindowKey, WindowMetric>;
    for (const window of WINDOW_KEYS) {
      const result = metricForWindow(window, poolBuckets, asOfDate, sourceCoverage[window] ?? null, pool.effectiveActiveTvl ?? pool.tvl);
      windows[window] = result.metric;
      const global = globalWindows[window];
      const coverage = result.coverage;
      global.eventCount += coverage.eventCount;
      global.signaturesDiscovered += coverage.signaturesDiscovered;
      global.transactionsFetched += coverage.transactionsFetched;
      global.transactionsSuccessful += coverage.transactionsSuccessful;
      global.transactionsFailed += coverage.transactionsFailed;
      global.swapsParsed += coverage.swapsParsed;
      global.swapsRejected += coverage.swapsRejected;
      global.duplicatesRemoved += coverage.duplicatesRemoved;
      global.poolCount += coverage.eventCount > 0 ? 1 : 0;
      global.persisted ||= coverage.persisted;
      if (coverage.backfillStatus === "COMPLETE" || coverage.backfillStatus === "LIVE") {
        global.backfillStatus = global.backfillStatus === "UNAVAILABLE" || global.backfillStatus === "COMPLETE" || global.backfillStatus === "LIVE" ? coverage.backfillStatus : global.backfillStatus;
      } else if (coverage.backfillStatus === "BACKFILLING" || coverage.backfillStatus === "RUNNING") {
        global.backfillStatus = "BACKFILLING";
      } else if (global.backfillStatus === "UNAVAILABLE") {
        global.backfillStatus = "PARTIAL";
      }
    }
    const recentSwaps = (input.eventsByPool.get(pool.id) ?? []).slice(0, 20);
    poolStates.set(pool.id, {
      pairKey: pool.pairKey,
      state: {
        windows,
        routeShareByWindow: Object.fromEntries(WINDOW_KEYS.map((key) => [key, emptyRouteShare(key, 1, input.asOf)])) as Record<WindowKey, RouteShareMetric>,
        feeDensity: windows["1h"].feeDensity ?? null,
        velocity: windows["1h"].liquidityVelocity ?? null,
        effectiveActiveTvl: windows["1h"].activeTvl ?? pool.effectiveActiveTvl,
        recentSwaps,
        updatedAt: input.asOf,
      },
    });
  }
  const pairGroups = new Map<string, string[]>();
  for (const [poolId, item] of poolStates) pairGroups.set(item.pairKey, [...(pairGroups.get(item.pairKey) ?? []), poolId]);
  for (const [poolId, item] of poolStates) {
    const siblings = pairGroups.get(item.pairKey) ?? [poolId];
    for (const window of WINDOW_KEYS) {
      const metrics = siblings.map((id) => poolStates.get(id)?.state.windows[window]).filter((metric): metric is WindowMetric => Boolean(metric));
      const known = metrics.filter((metric) => finite(metric.volume));
      const denominator = known.length > 0 ? sum(known.map((metric) => metric.volume)) : null;
      const current = item.state.windows[window];
      const route: RouteShareMetric = {
        share: denominator !== null && current.volume !== null && denominator > 0 ? current.volume / denominator : null,
        pairPoolCount: siblings.length,
        windowActivePoolCount: known.filter((metric) => (metric.volume ?? 0) > 0).length,
        denominatorVolume: denominator,
        poolVolume: current.volume,
        unattributedVolume: known.length === metrics.length ? 0 : null,
        source: "all Raydium pools sharing base mint",
        observedAt: input.asOf,
      };
      item.state.routeShareByWindow[window] = route;
      item.state.windows[window] = { ...current, routeShare: route.share };
    }
  }
  for (const window of WINDOW_KEYS) {
    const rows = [...poolStates.values()].map((item) => item.state.windows[window]);
    const known = rows.filter((metric) => metric.status !== "UNAVAILABLE");
    const complete = known.length === rows.length && rows.length > 0 && rows.every((metric) => (metric.status === "COMPLETE" || metric.status === "LIVE") && metric.coverageRatio === 100);
    globalWindows[window].backfillStatus = complete ? (rows.some((metric) => metric.status === "LIVE") ? "LIVE" : "COMPLETE") : known.some((metric) => metric.status === "BACKFILLING" || metric.status === "RUNNING") ? "BACKFILLING" : known.length > 0 ? "PARTIAL" : "UNAVAILABLE";
    globalWindows[window].coverageRatio = rows.length > 0 ? rows.reduce((total, metric) => total + (metric.coverageRatio ?? 0), 0) / rows.length : null;
    globalWindows[window].eventCount = rows.reduce((total, metric) => total + (metric.swapCount ?? 0), 0);
    globalWindows[window].poolCount = rows.filter((metric) => (metric.volume ?? 0) > 0).length;
  }
  return { pools: Object.fromEntries([...poolStates].map(([id, value]) => [id, value.state])), windows: globalWindows };
}

export function coverageStatusLabel(status: EventWindowCoverage["backfillStatus"]): string {
  if (status === "COMPLETE" || status === "LIVE") return "完整";
  if (status === "BACKFILLING" || status === "RUNNING") return "正在回补";
  if (status === "PARTIAL") return "部分完整";
  return "不可用";
}

export { percentDifference };
