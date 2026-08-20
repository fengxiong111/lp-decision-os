const STATUS_RANK = Object.freeze({ READY: 0, NEAR_READY: 1, BLOCKED: 2 });
const CORE_KEYS = Object.freeze([
  "poolIdentity",
  "poolState",
  "tickArray",
  "currentPrice",
  "tick",
  "activeLiquidity",
  "swapReplay",
  "tickPath",
  "shadowReplay",
  "feeReplay",
  "executionCost",
]);

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function item(key, label, status, reason, display = status) {
  return { key, label, status, display, reason: reason ?? null };
}

function isPass(itemValue) {
  return itemValue?.status === "PASS";
}

function pathStatus(path) {
  if (path?.divergence === true || path?.stateContinuityPass === false || path?.currentStateAfterReplay === false) {
    return item("tickPath", "Tick path", "FAIL", "回放状态发生 divergence 或连续性失败");
  }
  if (path?.pass === true) return item("tickPath", "Tick path", "PASS", "逐笔 Tick path 与当前状态连续");
  return item("tickPath", "Tick path", "WARN", "Tick path 尚未完成", "WAITING");
}

function netBounds(pool, optimizer) {
  const best = optimizer?.best ?? null;
  const base = finite(best?.expectedNetFee24h);
  if (base === null) {
    return {
      NET_LOW: null,
      NET_BASE: null,
      NET_HIGH: null,
      uncertaintyUsd: null,
      status: "WAITING",
      reason: "净收益模型尚未完成",
      formula: "等待完整 replay / cost / markout 后计算",
    };
  }

  const pathCoverage = finite(pool.evidence?.swaps?.path?.coverageRatio);
  const feeCoverage = finite(pool.evidence?.swaps?.windows?.["24"]?.feeCoverage);
  const knownCoverage = Math.min(pathCoverage ?? 0, feeCoverage ?? 0);
  const gross = Math.abs(finite(best.grossFee24h) ?? base);
  const uncertaintyUsd = gross * Math.max(0, 1 - Math.min(1, knownCoverage));
  return {
    NET_LOW: base - uncertaintyUsd,
    NET_BASE: base,
    NET_HIGH: base + uncertaintyUsd,
    uncertaintyUsd,
    status: uncertaintyUsd === 0 ? "STABLE" : "RANGE",
    reason: uncertaintyUsd === 0 ? "完整可用证据未产生区间不确定性" : "未完成路径/费用证据的已知毛费影响范围",
    formula: "NET_BASE ± GROSS_FEE × (1 − min(pathCoverage, feeCoverage))",
  };
}

export function deriveVolatilityRegime(pool) {
  const dynamicFeeInfo = pool.evidence?.poolState?.dynamicFeeInfo ?? null;
  const accumulator = finite(dynamicFeeInfo?.volatilityAccumulator);
  const maximum = finite(dynamicFeeInfo?.maxVolatilityAccumulator);
  if (accumulator === null || maximum === null || maximum <= 0) {
    return {
      regime: null,
      ratio: null,
      source: "Raydium PoolState.dynamicFeeInfo",
      confidence: null,
      reason: "PoolState 未提供可比较的 volatility accumulator",
      optimizerImpact: "未参与策略偏好",
    };
  }
  const ratio = Math.max(0, Math.min(1, accumulator / maximum));
  const regime = ratio < 0.25 ? "LOW_VOL" : ratio < 0.65 ? "NORMAL_VOL" : "HIGH_VOL";
  return {
    regime,
    ratio,
    source: "Raydium PoolState.dynamicFeeInfo.volatilityAccumulator / maxVolatilityAccumulator",
    confidence: "OBSERVED",
    reason: `归一化波动累积值 ${(ratio * 100).toFixed(1)}%`,
    optimizerImpact: regime === "LOW_VOL" ? "同净收益候选优先更窄 Core" : regime === "HIGH_VOL" ? "同净收益候选优先更宽 Core / Buffer" : "保持候选净收益排序",
  };
}

export function buildPoolDiagnostic(pool, optimizer, matrixRow = null) {
  const evidence = pool.evidence ?? {};
  const parser = evidence.swaps?.parser ?? {};
  const window24 = evidence.swaps?.windows?.["24"] ?? null;
  const path = evidence.swaps?.path ?? null;
  const shadow = evidence.shadowReplay ?? null;
  const feeGrowth = evidence.feeGrowthReconciliation ?? null;
  const cost = evidence.executionCosts ?? evidence.executionCostEvidence ?? null;

  const items = [
    item("poolIdentity", "Pool identity", pool.rwaIdentityVerified === true && pool.usdcIdentityVerified === true && pool.poolType === "CLMM" && pool.universeStatus === "ACTIVE_INDEXED" ? "PASS" : "FAIL", pool.universeStatus === "ACTIVE_INDEXED" ? "RWA / USDC CLMM identity 已核验" : "RWA / USDC / ACTIVE_INDEXED 身份尚未同时通过"),
    item("poolState", "PoolState", evidence.poolState?.poolStatePass === true ? "PASS" : "FAIL", evidence.poolState?.poolStatePass === true ? "PoolState identity、decimals、price、config 通过" : "PoolState 尚未通过"),
    item("tickArray", "TickArray", evidence.tickArrays?.tickArrayPass === true ? "PASS" : "FAIL", evidence.tickArrays?.tickArrayPass === true ? "TickArray 已解码" : "TickArray 尚未完整解码"),
    item("currentPrice", "Current price", finite(pool.currentPrice) !== null && pool.currentPrice > 0 ? "PASS" : "FAIL", finite(pool.currentPrice) !== null && pool.currentPrice > 0 ? "当前价格为正且可用于区间计算" : "当前价格缺失或无效"),
    item("tick", "Tick", finite(pool.currentTick) !== null && finite(pool.tickSpacing) !== null && pool.tickSpacing > 0 ? "PASS" : "FAIL", finite(pool.currentTick) !== null && finite(pool.tickSpacing) !== null && pool.tickSpacing > 0 ? "Current Tick / TickSpacing 可用于合法 snap" : "Current Tick 或 TickSpacing 缺失"),
    item("activeLiquidity", "Active liquidity", finite(pool.activeLiquidity) !== null && pool.activeLiquidity > 0 ? "PASS" : "FAIL", finite(pool.activeLiquidity) !== null && pool.activeLiquidity > 0 ? "Active liquidity 可用于 replay" : "Active liquidity 缺失或无效"),
    item("swapReplay", "Swap replay", evidence.replayEvidence && window24?.windowComplete === true && evidence.swapIndexPass === true ? "PASS" : "FAIL", evidence.replayEvidence && window24?.windowComplete === true && evidence.swapIndexPass === true ? "24h replay 完整" : "Swap window / replay 尚未完成"),
    pathStatus(path),
    item("shadowReplay", "Shadow replay", shadow?.candidateCount > 0 ? "PASS" : "FAIL", shadow?.candidateCount > 0 ? `已评估 ${shadow.candidateCount} 个 Core + Buffer 候选` : "Shadow replay 尚未产生候选"),
    item("feeReplay", "Fee replay", evidence.feeConfigVerified === true && (parser.amountReconciliationFailed ?? 0) === 0 && (window24?.feeCoverage ?? 0) >= 0.99 ? "PASS" : (parser.amountReconciliationFailed ?? 0) > 0 ? "FAIL" : "WARN", evidence.feeConfigVerified === true && (parser.amountReconciliationFailed ?? 0) === 0 ? "Pool fee 配置与 Swap fee 证据通过" : "Fee 配置或金额对账仍在验证", evidence.feeConfigVerified === true && (parser.amountReconciliationFailed ?? 0) === 0 ? "PASS" : "WAITING"),
    item("markout", "Markout", evidence.markout?.quality === "COMPLETE" || evidence.riskModel?.status === "PASS" ? "PASS" : "WARN", evidence.markout?.quality === "COMPLETE" ? "外部参考价格 Markout 已完成" : "外部参考价格 Markout 尚未完成", "WAITING"),
    item("feeGrowth", "Fee-growth", feeGrowth?.status === "PASS" ? "PASS" : "WARN", feeGrowth?.status === "PASS" ? "Fee-growth reconciliation 通过" : "Fee-growth reconciliation 尚未完成", "WAITING"),
    item("executionCost", "Execution cost", cost !== null && cost.quality !== "UNAVAILABLE" ? "PASS" : "FAIL", cost !== null && cost.quality !== "UNAVAILABLE" ? "Open / rebalance cost 已有可复用估计" : "Execution cost evidence 缺失"),
  ];

  const byKey = new Map(items.map((entry) => [entry.key, entry]));
  const coreEstablished = CORE_KEYS.every((key) => isPass(byKey.get(key)));
  const hardFailure = ["poolIdentity", "poolState", "tickArray", "currentPrice", "tick", "activeLiquidity", "swapReplay", "tickPath", "shadowReplay"].some((key) => byKey.get(key)?.status === "FAIL");
  const allPass = items.every(isPass);
  const status = optimizer?.executable === true && allPass
    ? "READY"
    : !hardFailure && coreEstablished && ["markout", "feeGrowth"].some((key) => byKey.get(key)?.status !== "PASS")
      ? "NEAR_READY"
      : "BLOCKED";
  const failures = items.filter((entry) => entry.status === "FAIL");
  const warnings = items.filter((entry) => entry.status === "WARN");
  const primary = failures[0] ?? warnings[0] ?? null;
  const range = netBounds(pool, optimizer);
  const volatilityRegime = pool.volatilityRegime ?? deriveVolatilityRegime(pool);

  return {
    poolAddress: pool.poolAddress,
    pair: `${pool.symbol}/USDC`,
    status,
    readyForTop3: status === "READY" && optimizer?.executable === true,
    primaryBlocker: primary ? { key: primary.key, label: primary.label, display: primary.display, reason: primary.reason } : null,
    passCount: items.filter(isPass).length,
    totalChecks: items.length,
    evidence: items,
    netRange: range,
    volatilityRegime,
    action: status === "READY" ? optimizer?.action ?? "UNAVAILABLE" : "UNAVAILABLE",
    rankingImpact: status === "READY" ? "可进入 Top3" : status === "NEAR_READY" ? "仅诊断，不进入 Top3" : "不进入 Top3",
    sourceBlockers: [...new Set([...(pool.evidence?.blockers ?? []), ...(matrixRow?.replay?.blockers ?? [])])],
  };
}

export function buildDiagnosticReport(results, matrixByPool = new Map()) {
  const matrix = results.map(({ pool, optimizer }) => buildPoolDiagnostic(pool, optimizer, matrixByPool.get(pool.poolAddress))).sort((left, right) => {
    return STATUS_RANK[left.status] - STATUS_RANK[right.status]
      || right.passCount - left.passCount
      || (right.netRange.NET_BASE ?? -Infinity) - (left.netRange.NET_BASE ?? -Infinity)
      || left.pair.localeCompare(right.pair);
  });
  const statusCounts = matrix.reduce((counts, row) => ({ ...counts, [row.status]: (counts[row.status] ?? 0) + 1 }), { READY: 0, NEAR_READY: 0, BLOCKED: 0 });
  return {
    version: 1,
    statusCounts,
    readyCount: statusCounts.READY,
    nearReadyCount: statusCounts.NEAR_READY,
    blockedCount: statusCounts.BLOCKED,
    matrix,
    nearest: matrix.slice(0, 8),
  };
}

export function statusForTop3(diagnostic) {
  return diagnostic?.status === "READY" && diagnostic.readyForTop3 === true;
}
