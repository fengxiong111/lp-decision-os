import type { BackfillJobSnapshot, BackfillPoolCursor, BackfillStatus, EventWindowCoverage, WindowKey } from "@/packages/models/src";

export const RAW_BACKFILL_JOB_ID = "rwa-raw-swaps-12h";
export const RAW_BACKFILL_HOURS = 12;
export const SHORT_WINDOWS: Array<"1h" | "6h" | "12h"> = ["1h", "6h", "12h"];

export const EXPECTED_BUCKET_COUNTS: Record<"1h" | "6h" | "12h", number> = {
  "1h": 60,
  "6h": 360,
  "12h": 720,
};

const WINDOW_MS: Record<"1h" | "6h" | "12h", number> = {
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "12h": 12 * 60 * 60_000,
};

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

export function timeCoveragePercent(cursor: BackfillPoolCursor | null, window: "1h" | "6h" | "12h", now: Date): number {
  if (!cursor?.oldestFetchedBlockTime) return 0;
  const oldest = Date.parse(cursor.oldestFetchedBlockTime);
  if (!Number.isFinite(oldest)) return 0;
  const elapsed = Math.max(0, now.getTime() - oldest);
  return clamp((elapsed / WINDOW_MS[window]) * 100);
}

export function isCursorComplete(cursor: BackfillPoolCursor | null, target: Date): boolean {
  if (!cursor || !cursor.oldestFetchedBlockTime) return false;
  return cursor.status === "COMPLETE" && Date.parse(cursor.oldestFetchedBlockTime) <= target.getTime() && cursor.transactionsFailed === 0 && cursor.unknownInstructions === 0;
}

/**
 * 1h/6h/12h 的完成语义只看可审计事实，不看四舍五入后的 coverage 百分比。
 * 零成交分钟也必须已经物化，因此 metricsBucketCount 可以与 expectedBucketCount
 * 直接比较。oldestCoveredBlockTime 与 windowStart 使用同一 UTC 时间轴。
 */
export function deterministicWindowComplete(input: {
  window: "1h" | "6h" | "12h";
  windowStart: string | null | undefined;
  oldestCoveredBlockTime: string | null | undefined;
  unresolvedRetryableTransactions: number | null | undefined;
  gapCount: number | null | undefined;
  metricsBucketCount: number | null | undefined;
}): boolean {
  const start = input.windowStart ? Date.parse(input.windowStart) : Number.NaN;
  const oldest = input.oldestCoveredBlockTime ? Date.parse(input.oldestCoveredBlockTime) : Number.NaN;
  return Number.isFinite(start)
    && Number.isFinite(oldest)
    && oldest <= start
    && input.unresolvedRetryableTransactions === 0
    && input.gapCount === 0
    && typeof input.metricsBucketCount === "number"
    && input.metricsBucketCount >= EXPECTED_BUCKET_COUNTS[input.window];
}

export function coverageIsDeterministicallyComplete(coverage: EventWindowCoverage | null | undefined, window: "1h" | "6h" | "12h"): boolean {
  if (!coverage) return false;
  return (coverage.backfillStatus === "COMPLETE" || coverage.backfillStatus === "LIVE")
    && deterministicWindowComplete({
      window,
      windowStart: coverage.windowStart,
      oldestCoveredBlockTime: coverage.oldestCoveredBlockTime ?? coverage.oldestCoveredAt,
      unresolvedRetryableTransactions: coverage.unresolvedRetryableTransactions,
      gapCount: coverage.gapCount ?? coverage.gapSlots,
      metricsBucketCount: coverage.metricsBucketCount,
    });
}

export function estimateEtaMs(history: BackfillJobSnapshot["progressHistory"], completedPoolCount: number, targetPoolCount: number, now: Date): number | null {
  const samples = history.filter((sample) => Date.parse(sample.at) >= now.getTime() - 5 * 60_000).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last || Date.parse(last.at) <= Date.parse(first.at)) return null;
  const completedDelta = last.completedPoolCount - first.completedPoolCount;
  if (completedDelta <= 0 || targetPoolCount <= completedPoolCount) return null;
  const rate = completedDelta / (Date.parse(last.at) - Date.parse(first.at));
  return Math.ceil((targetPoolCount - completedPoolCount) / rate);
}

export function validateWindowProgress(progress: Record<"1h" | "6h" | "12h", number | null>): { valid: boolean; reason: string | null } {
  if (progress["1h"] === null || progress["6h"] === null || progress["12h"] === null) return { valid: true, reason: null };
  const valid = progress["1h"] + 1e-9 >= progress["6h"] && progress["6h"] + 1e-9 >= progress["12h"];
  return valid ? { valid: true, reason: null } : { valid: false, reason: `BACKFILL_PROGRESS_INVALID：1h ${progress["1h"].toFixed(2)}% < 6h ${progress["6h"].toFixed(2)}% 或 6h < 12h` };
}

export function deriveWindowCoverage(input: {
  window: "1h" | "6h" | "12h";
  cursors: BackfillPoolCursor[];
  targetPoolCount: number;
  now: Date;
  job: BackfillJobSnapshot | null;
  base?: Partial<EventWindowCoverage>;
}): EventWindowCoverage {
  const completeCount = input.cursors.filter((cursor) => isCursorComplete(cursor, new Date(input.job?.targetBlockTime ?? input.now.getTime() - RAW_BACKFILL_HOURS * 60 * 60_000))).length;
  const coverageRatio = input.targetPoolCount > 0 ? (completeCount / input.targetPoolCount) * 100 : null;
  const timeRatios = input.cursors.map((cursor) => timeCoveragePercent(cursor, input.window, input.now));
  const averageTimeCoverage = timeRatios.length > 0 ? timeRatios.reduce((sum, item) => sum + item, 0) / timeRatios.length : null;
  const base = input.base ?? {};
  const status: BackfillStatus = input.job?.status === "BACKFILL_PROGRESS_INVALID"
    ? "INVALID"
    : input.job?.status === "BLOCKED" || input.job?.status === "STALLED"
      ? input.job.status
      : input.targetPoolCount === 0
        ? "UNAVAILABLE"
      : completeCount === input.targetPoolCount && input.targetPoolCount > 0
        ? input.job?.status === "LIVE" ? "LIVE" : "COMPLETE"
        : completeCount > 0 || (averageTimeCoverage !== null && averageTimeCoverage > 0) ? "PARTIAL" : "BACKFILLING";
  const oldestCoveredAt = input.cursors
    .map((cursor) => cursor.oldestFetchedBlockTime)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(0) ?? null;
  const stalledPoolCount = input.cursors.filter((cursor) => cursor.status === "STALLED").length;
  const blockedPoolCount = input.cursors.filter((cursor) => cursor.status === "BLOCKED" || cursor.status === "FAILED").length;
  const etaMs = input.job?.etaMs ?? null;
  const recentHistory = (input.job?.progressHistory ?? []).filter((sample) => Date.parse(sample.at) >= input.now.getTime() - 5 * 60_000).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const firstRecent = recentHistory[0];
  const lastRecent = recentHistory.at(-1);
  const recentMinutes = firstRecent && lastRecent ? Math.max(0, (Date.parse(lastRecent.at) - Date.parse(firstRecent.at)) / 60_000) : 0;
  const transactionsPerMinute = recentMinutes > 0 && firstRecent && lastRecent
    ? Math.max(0, ((lastRecent.transactionsFetched ?? 0) - (firstRecent.transactionsFetched ?? 0)) / recentMinutes)
    : null;
  const completedPoolsLast5m = firstRecent && lastRecent ? Math.max(0, lastRecent.completedPoolCount - firstRecent.completedPoolCount) : 0;
  const stalled = input.job?.lastProgressAt ? input.now.getTime() - Date.parse(input.job.lastProgressAt) >= 5 * 60_000 : false;
  return {
    eventCount: base.eventCount ?? 0,
    poolCount: base.poolCount ?? 0,
    firstSlot: base.firstSlot ?? null,
    lastSlot: base.lastSlot ?? null,
    firstEventAt: base.firstEventAt ?? null,
    lastEventAt: base.lastEventAt ?? null,
    completeness: status === "COMPLETE" || status === "LIVE" ? 100 : averageTimeCoverage,
    persisted: base.persisted ?? false,
    source: "normalized_swaps → pool_metrics_1m · 单一12h回补",
    windowStart: new Date(input.now.getTime() - WINDOW_MS[input.window]).toISOString(),
    windowEnd: input.now.toISOString(),
    startSlot: base.startSlot ?? null,
    endSlot: base.endSlot ?? null,
    expectedSlotRange: base.expectedSlotRange ?? null,
    signaturesDiscovered: base.signaturesDiscovered ?? input.cursors.reduce((sum, cursor) => sum + cursor.signaturesDiscovered, 0),
    transactionsFetched: base.transactionsFetched ?? input.cursors.reduce((sum, cursor) => sum + cursor.transactionsFetched, 0),
    transactionsSuccessful: base.transactionsSuccessful ?? input.cursors.reduce((sum, cursor) => sum + Math.max(0, cursor.transactionsFetched - cursor.transactionsFailed), 0),
    transactionsFailed: base.transactionsFailed ?? input.cursors.reduce((sum, cursor) => sum + cursor.transactionsFailed, 0),
    swapsParsed: base.swapsParsed ?? input.cursors.reduce((sum, cursor) => sum + cursor.transactionsParsed, 0),
    swapsRejected: base.swapsRejected ?? input.cursors.reduce((sum, cursor) => sum + cursor.unknownInstructions, 0),
    duplicatesRemoved: base.duplicatesRemoved ?? 0,
    unknownInstructions: base.unknownInstructions ?? input.cursors.reduce((sum, cursor) => sum + cursor.unknownInstructions, 0),
    gapSlots: status === "COMPLETE" || status === "LIVE" ? 0 : base.gapSlots ?? null,
    coverageRatio,
    firstEventTime: base.firstEventTime ?? null,
    lastEventTime: base.lastEventTime ?? null,
    backfillStatus: status,
    targetPoolCount: input.targetPoolCount,
    completedPoolCount: completeCount,
    timeCoverageRatio: averageTimeCoverage,
    etaMs,
    etaAt: etaMs === null ? null : new Date(input.now.getTime() + etaMs).toISOString(),
    oldestCoveredAt,
    lastProgressAt: input.job?.lastProgressAt ?? null,
    requestsLast5m: input.job?.requestsLast5m ?? 0,
    successfulTransactionsLast5m: input.job?.successfulTransactionsLast5m ?? 0,
    rpc429Last5m: input.job?.rpc429Last5m ?? 0,
    stalledPoolCount,
    blockedPoolCount,
    progressError: input.job?.status === "BACKFILL_PROGRESS_INVALID" ? input.job.blockedReason : null,
    transactionsPerMinute,
    completedPoolsLast5m,
    progressReason: stalled && input.job?.status !== "LIVE" ? "RPC当前限流或最近5分钟无推进" : input.targetPoolCount === 0 ? "没有进入短窗口的活跃 Pool" : null,
  };
}

export function progressForWindows(cursors: BackfillPoolCursor[], targetPoolCount: number, now: Date, job: BackfillJobSnapshot | null): Record<"1h" | "6h" | "12h", number | null> {
  const result: Record<"1h" | "6h" | "12h", number | null> = { "1h": null, "6h": null, "12h": null };
  for (const window of SHORT_WINDOWS) {
    // 进度按同一批 cursor 的时间覆盖计算，避免 signature 数量造成 1h/6h/12h 互相矛盾。
    result[window] = deriveWindowCoverage({ window, cursors, targetPoolCount, now, job }).timeCoverageRatio ?? null;
  }
  return result;
}

/** @deprecated 旧调用方没有足够证据，必须迁移到 coverageIsDeterministicallyComplete。 */
export function windowIsComplete(status: BackfillStatus | undefined, _coverageRatio: number | null | undefined, gapSlots: number | null | undefined, unresolvedRetryableTransactions: number | null | undefined, evidence?: Partial<Omit<Parameters<typeof deterministicWindowComplete>[0], "window">>): boolean {
  if (!evidence || (status !== "COMPLETE" && status !== "LIVE")) return false;
  return deterministicWindowComplete({
    window: "1h",
    windowStart: evidence.windowStart,
    oldestCoveredBlockTime: evidence.oldestCoveredBlockTime,
    metricsBucketCount: evidence.metricsBucketCount,
    gapCount: gapSlots,
    unresolvedRetryableTransactions,
  });
}

export function formatEta(etaMs: number | null | undefined): string {
  if (etaMs === null || etaMs === undefined || !Number.isFinite(etaMs)) return "等待回补速度";
  const minutes = Math.max(1, Math.round(etaMs / 60_000));
  return minutes < 60 ? `预计${minutes}分钟` : `预计${Math.floor(minutes / 60)}小时${minutes % 60}分钟`;
}

export function windowProgressState(coverage: EventWindowCoverage): "完整" | "部分完整" | "正在回补" | "卡住" | "不可用" {
  if (coverage.progressError || coverage.backfillStatus === "INVALID" || coverage.backfillStatus === "BLOCKED") return "卡住";
  if (coverage.backfillStatus === "COMPLETE" || coverage.backfillStatus === "LIVE") return "完整";
  if (coverage.backfillStatus === "BACKFILLING" || coverage.backfillStatus === "RUNNING" || coverage.backfillStatus === "STALLED") return "正在回补";
  if (coverage.backfillStatus === "PARTIAL") return "部分完整";
  return "不可用";
}

export function metricWindowKey(window: WindowKey): "1h" | "6h" | "12h" | null {
  return window === "1h" || window === "6h" || window === "12h" ? window : null;
}
