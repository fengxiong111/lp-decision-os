import {
  CAPITAL_OPTIONS,
  type DecisionAction,
  DecisionHorizon,
  DecisionStatus,
  ExplainReason,
  MigrationDecision,
  PoolDecision,
  PoolSnapshot,
  PositionSnapshot,
  YieldPrediction,
  WindowKey,
} from "@/packages/models/src";

const HORIZONS: Array<{ key: DecisionHorizon; hours: number }> = [
  { key: "1h", hours: 1 },
  { key: "6h", hours: 6 },
  { key: "12h", hours: 12 },
  { key: "24h", hours: 24 },
];

const SAMPLE_WINDOWS: Array<{ key: WindowKey; hours: number }> = [
  { key: "1h", hours: 1 },
  { key: "6h", hours: 6 },
  { key: "12h", hours: 12 },
];

const MODEL_VERSION = "lp-alpha-terminal-v4";

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function validNumber(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

function metricFee(pool: PoolSnapshot, key: WindowKey): number | null {
  const metric = pool.windows[key];
  if (metric.status !== "COMPLETE") return null;
  const fee = metric.lpFeeUsd ?? metric.fee;
  return validNumber(fee) && fee >= 0 ? fee : null;
}

function metricVolume(pool: PoolSnapshot, key: WindowKey): number | null {
  const value = pool.windows[key].volume;
  return validNumber(value) && value >= 0 ? value : null;
}

function trendPercent(pool: PoolSnapshot): number | null {
  const oneHour = metricVolume(pool, "1h");
  const sixHour = metricVolume(pool, "6h");
  if (oneHour === null || sixHour === null || sixHour <= 0) return null;
  const recentHourlyRate = oneHour;
  const priorHourlyRate = sixHour / 6;
  return clamp((recentHourlyRate / Math.max(priorHourlyRate, 0.000001) - 1) * 100, -95, 400);
}

function baselineFee(pool: PoolSnapshot): { feePerHour: number; sourceWindow: WindowKey } | null {
  for (const sample of SAMPLE_WINDOWS) {
    const fee = metricFee(pool, sample.key);
    if (fee !== null) return { feePerHour: fee / sample.hours, sourceWindow: sample.key };
  }
  return null;
}

function confidenceFor(pool: PoolSnapshot, sourceWindow: WindowKey | null, trend: number | null): number | null {
  if (!sourceWindow) return null;
  const quality = validNumber(pool.confidence) ? pool.confidence : 50;
  const trendPenalty = trend === null ? 20 : Math.min(20, Math.abs(trend) / 10);
  return Math.round(clamp(quality - trendPenalty, 0, 100));
}

function predictYield(pool: PoolSnapshot, capitalUsd: number, horizon: DecisionHorizon, hours: number): YieldPrediction {
  const baseline = baselineFee(pool);
  const trend = trendPercent(pool);
  const estimate = pool.executableEstimates[String(capitalUsd)]?.["12h"] ?? null;
  if (!baseline || estimate?.userLiquidityShare === null || estimate?.userLiquidityShare === undefined || estimate.inRangeProbability === null || estimate.inRangeProbability === undefined || estimate.dataQualityFactor === null || estimate.dataQualityFactor === undefined || trend === null) {
    return {
      horizon,
      expectedPoolFeeUsd: null,
      expectedLpFeeUsd: null,
      expectedNetProfitUsd: null,
      netReturnPct: null,
      trendPct: trend,
      confidence: null,
      status: "WAITING_DATA",
      sourceWindow: baseline?.sourceWindow ?? null,
      reason: "等待完整窗口 LP Fee、成交趋势、区间概率或数据质量",
    };
  }
  const trendFactor = clamp(1 + trend / 100, 0.25, 4);
  const expectedPoolFeeUsd = baseline.feePerHour * hours * trendFactor;
  const inRangeProbability = estimate.inRangeProbability;
  const expectedLpFeeUsd = expectedPoolFeeUsd * estimate.userLiquidityShare * inRangeProbability;
  const confidence = confidenceFor(pool, baseline.sourceWindow, trend);
  return {
    horizon,
    expectedPoolFeeUsd,
    expectedLpFeeUsd,
    expectedNetProfitUsd: null,
    netReturnPct: null,
    trendPct: trend,
    confidence,
    status: "READY",
    sourceWindow: baseline.sourceWindow,
    reason: "基于最近完整窗口 LP Fee、成交趋势、投入后份额和区间概率预测",
  };
}

function capacityReason(pool: PoolSnapshot, capitalUsd: number): ExplainReason {
  const estimate = pool.executableEstimates[String(capitalUsd)]?.["12h"];
  const ratio = estimate?.capitalToActiveTvlRatio;
  if (!estimate || ratio === null || ratio === undefined) {
    return { direction: "negative", label: "容量", value: "等待数据", detail: "等待有效 TVL 以判断投入容量", weight: 0.3 };
  }
  if (estimate.capacityStatus === "禁止") {
    return { direction: "negative", label: "容量不足", value: estimate.capacityStatus, detail: `投入 ${capitalUsd}U 将占有效 TVL ${(ratio * 100).toFixed(1)}%`, weight: 0.5 };
  }
  return { direction: "positive", label: "容量", value: estimate.capacityStatus, detail: estimate.recommendedMaxCapitalUsd === null ? "等待有效 TVL 计算建议上限" : `建议最大投入约 ${Math.round(estimate.recommendedMaxCapitalUsd)}U`, weight: 0.25 };
}

function explainReasons(pool: PoolSnapshot, capitalUsd: number, predictions: Record<DecisionHorizon, YieldPrediction>): ExplainReason[] {
  const reasons: ExplainReason[] = [capacityReason(pool, capitalUsd)];
  const route = pool.routeShareByWindow["6h"].share ?? pool.routeShareByWindow["24h"].share;
  if (validNumber(route)) {
    reasons.push({
      direction: route >= 80 ? "positive" : "negative",
      label: "Route Share",
      value: `${route.toFixed(1)}%`,
      detail: route >= 80 ? "承接同一 Pair 的主要成交" : "同一 Pair 仍有其它 Pool 承接主要成交",
      weight: 0.2,
    });
  }
  const trend = predictions["12h"].trendPct;
  if (trend !== null) {
    reasons.push({
      direction: trend >= 0 ? "positive" : "negative",
      label: "成交趋势",
      value: `${trend >= 0 ? "+" : ""}${trend.toFixed(0)}%`,
      detail: "最近 1h 成交速率相对最近 6h 平均速率",
      weight: 0.2,
    });
  }
  const density = pool.feeDensity;
  if (validNumber(density)) {
    reasons.push({
      direction: density > 1 ? "positive" : "negative",
      label: "Fee Density",
      value: `${density.toFixed(2)}%`,
      detail: "官方 24h Fee / 有效 TVL，仅作为输入，不直接决定排名",
      weight: 0.1,
    });
  }
  if (predictions["12h"].status !== "READY") {
    reasons.push({ direction: "negative", label: "数据门槛", value: "等待回补", detail: predictions["12h"].reason, weight: 0.4 });
  }
  return reasons.slice(0, 5);
}

function actionFor(status: DecisionStatus, estimate: PoolSnapshot["executableEstimates"][string][WindowKey] | undefined): DecisionAction {
  if (status === "CAPACITY_BLOCKED" || estimate?.capacityStatus === "禁止") return "AVOID";
  if (status === "READY") return "BUY";
  return "WAIT";
}

function buildDecision(pool: PoolSnapshot, capitalUsd: number): PoolDecision {
  const predictions = Object.fromEntries(HORIZONS.map(({ key, hours }) => [key, predictYield(pool, capitalUsd, key, hours)])) as Record<DecisionHorizon, YieldPrediction>;
  const estimate = pool.executableEstimates[String(capitalUsd)]?.["12h"];
  const capacityBlocked = estimate?.capacityStatus === "禁止" || estimate?.capacityStatus === "过小";
  const status: DecisionStatus = capacityBlocked ? "CAPACITY_BLOCKED" : predictions["12h"].status === "READY" && predictions["12h"].expectedNetProfitUsd !== null ? "READY" : "WAITING_DATA";
  const action = actionFor(status, estimate);
  const confidence = predictions["12h"].confidence;
  const risk = capacityBlocked ? "High" : estimate?.risk === "低" ? "Low" : estimate?.risk === "中" ? "Medium" : estimate?.risk === "高" ? "High" : "Unavailable";
  const starRating = status === "READY" && confidence !== null ? Math.max(1, Math.min(5, Math.round(confidence / 20))) : null;
  const rankingBasis = predictions["12h"].expectedNetProfitUsd !== null
    ? "NET_PROFIT"
    : predictions["12h"].expectedLpFeeUsd !== null
      ? "LP_FEE"
      : "CAPACITY_ONLY";
  const score = predictions["12h"].expectedNetProfitUsd ?? predictions["12h"].expectedLpFeeUsd;
  return {
    capitalUsd,
    status,
    action,
    recommended: status === "READY" && action === "BUY",
    starRating,
    score,
    rankingBasis,
    confidence,
    risk,
    selectedHorizon: "12h",
    predictions,
    reasons: explainReasons(pool, capitalUsd, predictions),
    migration: null,
    modelVersion: MODEL_VERSION,
  };
}

function migrationFor(pool: PoolSnapshot, pools: PoolSnapshot[], positions: PositionSnapshot[], capitalUsd: number): MigrationDecision {
  const position = positions.find((item) => item.poolAddress === pool.id);
  if (!position) return { status: "NOT_APPLICABLE", action: "HOLD", score: null, fromPoolAddress: null, toPoolAddress: null, expectedAdditionalNetUsd: null, expectedAdditionalFeeUsd: null, migrationCostUsd: null, paybackHours: null, reason: "连接只读钱包后计算我的仓位迁移" };
  const samePair = pools.filter((item) => item.pairKey === pool.pairKey && item.id !== pool.id);
  const current = pool.decisions?.[String(capitalUsd)]?.predictions["12h"];
  const best = samePair
    .map((item) => ({ pool: item, prediction: item.decisions?.[String(capitalUsd)]?.predictions["12h"] ?? null }))
    .filter((item): item is { pool: PoolSnapshot; prediction: YieldPrediction } => item.prediction?.expectedNetProfitUsd !== null && item.prediction?.expectedNetProfitUsd !== undefined)
    .sort((a, b) => b.prediction.expectedNetProfitUsd! - a.prediction.expectedNetProfitUsd!)[0];
  if (!current || !best || current.expectedNetProfitUsd === null || best.prediction?.expectedNetProfitUsd === null) {
    return { status: "WAITING_DATA", action: "WAIT", score: null, fromPoolAddress: pool.id, toPoolAddress: best?.pool.id ?? null, expectedAdditionalNetUsd: null, expectedAdditionalFeeUsd: null, migrationCostUsd: null, paybackHours: null, reason: "等待两个 Pool 的未来净收益与迁移执行成本" };
  }
  const delta = best.prediction.expectedNetProfitUsd - current.expectedNetProfitUsd;
  return { status: "WAITING_DATA", action: delta > 0 ? "WAIT" : "HOLD", score: delta > 0 ? 50 : 0, fromPoolAddress: pool.id, toPoolAddress: best.pool.id, expectedAdditionalNetUsd: delta, expectedAdditionalFeeUsd: null, migrationCostUsd: null, paybackHours: null, reason: "发现候选 Pool，但迁移成本尚未完成仿真" };
}

export function refreshDecisionModels(pools: PoolSnapshot[], positions: PositionSnapshot[] = []): PoolSnapshot[] {
  const withDecisions = pools.map((pool) => ({
    ...pool,
    decisions: Object.fromEntries(CAPITAL_OPTIONS.map((capital) => [String(capital), buildDecision(pool, capital)])),
  }));
  return withDecisions.map((pool) => ({
    ...pool,
    decisions: Object.fromEntries(Object.entries(pool.decisions ?? {}).map(([capital, decision]) => [capital, { ...decision, migration: migrationFor(pool, withDecisions, positions, Number(capital)) }])),
  }));
}
