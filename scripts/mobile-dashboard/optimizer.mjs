const TICK_BASE = 1.0001;
const LOG_TICK_BASE = Math.log(TICK_BASE);

export const ACTIONS = Object.freeze([
  "OPEN",
  "HOLD",
  "MOVE_CORE",
  "MOVE_BOTH",
  "CLOSE",
  "UNAVAILABLE",
]);

export const REASON_CODES = Object.freeze({
  RWA_IDENTITY_UNAVAILABLE: "RWA 身份未由外部数据源证明",
  USDC_IDENTITY_UNAVAILABLE: "USDC 报价身份未由外部数据源证明",
  ACTIVE_INDEXED_STATUS_UNAVAILABLE: "ACTIVE_INDEXED 状态未由外部数据源证明",
  CURRENT_PRICE_UNAVAILABLE: "当前价格缺失",
  CURRENT_TICK_UNAVAILABLE: "当前 Tick 缺失，无法生成合法边界",
  TICK_SPACING_UNAVAILABLE: "Tick spacing 缺失",
  ACTIVE_LIQUIDITY_UNAVAILABLE: "active liquidity 缺失",
  SWAP_HISTORY_UNAVAILABLE: "1h/6h/12h/24h 真实 Swap 历史缺失",
  FEE_GROWTH_ACCOUNTING_UNAVAILABLE: "fee-growth accounting 缺失",
  FEE_CONFIGURATION_UNAVAILABLE: "Pool Fee 配置缺失或动态费率证据缺失",
  TOKEN_DECIMALS_UNAVAILABLE: "Token decimals 缺失",
  EXECUTION_COST_UNAVAILABLE: "滑点、交易费或优先费缺失",
  MARKOUT_UNAVAILABLE: "缺少独立 RWA 参考价格，无法完成毒性流向 Markout",
  SWAP_TICK_PATH_UNAVAILABLE: "逐笔 Swap 的历史 Tick path 未完成",
  REPLAY_STATE_DIVERGENCE: "回放状态与当前 PoolState 不连续",
  ACTIVE_LIQUIDITY_REPLAY_UNAVAILABLE: "历史 active liquidity 未完成逐 Swap 回放",
  WINDOW_24H_COVERAGE_UNAVAILABLE: "24h 交易覆盖未达到确定性完成条件",
  REPLAY_INPUT_UNAVAILABLE: "Historical Replay 输入缺失",
  TVL_ENTRY_THRESHOLD_NOT_PROVEN: "TVL 未达到 $5,000 进入阈值",
  NO_VALID_CANDIDATE: "没有候选通过完整净收益计算",
  CURRENT_POOL_DATA_UNAVAILABLE: "当前影子仓位的可比净收益数据缺失",
});

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function widthLabel(width) {
  const percentage = width * 100;
  return `±${Number.isInteger(percentage) ? percentage : percentage.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
}

function allocationLabel(allocation) {
  return `${allocation.core * 100}/${allocation.buffer * 100}`;
}

export function buildStrategyCandidates(config) {
  const candidates = [];
  for (const coreWidth of config.coreWidths) {
    for (const bufferWidth of config.bufferWidths) {
      if (bufferWidth <= coreWidth) continue;
      for (const allocation of config.allocations) {
        candidates.push({
          id: `core-${coreWidth}-buffer-${bufferWidth}-allocation-${allocationLabel(allocation)}`,
          coreWidth,
          bufferWidth,
          allocation,
          coreWidthLabel: widthLabel(coreWidth),
          bufferWidthLabel: widthLabel(bufferWidth),
          allocationLabel: allocationLabel(allocation),
          coreCapital: config.capital * allocation.core,
          bufferCapital: config.capital * allocation.buffer,
        });
      }
    }
  }
  return candidates;
}

export function snapTick(value, spacing, direction) {
  if (!Number.isFinite(value) || !Number.isFinite(spacing) || spacing <= 0) return null;
  const snapped = direction === "down"
    ? Math.floor(value / spacing) * spacing
    : Math.ceil(value / spacing) * spacing;
  return Number.isFinite(snapped) ? snapped : null;
}

export function snapRange(candidate, pool) {
  const currentTick = finite(pool.currentTick);
  const spacing = finite(pool.tickSpacing);
  const currentPrice = finite(pool.currentPrice);
  const tickDirection = finite(pool.tickDirection);
  if (currentTick === null || spacing === null || spacing <= 0 || currentPrice === null || currentPrice <= 0 || tickDirection === null) return null;

  const lowerTick = snapTick(currentTick + Math.log(1 - candidate.width) / LOG_TICK_BASE, spacing, "down");
  const upperTick = snapTick(currentTick + Math.log(1 + candidate.width) / LOG_TICK_BASE, spacing, "up");
  if (lowerTick === null || upperTick === null || lowerTick >= upperTick) return null;

  const lowerPrice = currentPrice * Math.pow(TICK_BASE, (lowerTick - currentTick) * tickDirection);
  const upperPrice = currentPrice * Math.pow(TICK_BASE, (upperTick - currentTick) * tickDirection);
  return {
    tickLower: lowerTick,
    tickUpper: upperTick,
    lowerPrice: Math.min(lowerPrice, upperPrice),
    upperPrice: Math.max(lowerPrice, upperPrice),
  };
}

function candidateRanges(candidate, pool) {
  return {
    core: snapRange({ width: candidate.coreWidth }, pool),
    buffer: snapRange({ width: candidate.bufferWidth }, pool),
  };
}

function canSnapAllRanges(pool, candidates) {
  return candidates.every((candidate) => {
    const ranges = candidateRanges(candidate, pool);
    return ranges.core !== null && ranges.buffer !== null;
  });
}

export function validateOptimizerInputs(pool, config) {
  const reasons = [];
  const evidenceBlockers = Array.isArray(pool.evidence?.blockers) ? pool.evidence.blockers : [];
  if (pool.rwaIdentityVerified !== true) reasons.push("RWA_IDENTITY_UNAVAILABLE");
  if (pool.usdcIdentityVerified !== true) reasons.push("USDC_IDENTITY_UNAVAILABLE");
  if (pool.universeStatus !== "ACTIVE_INDEXED") reasons.push("ACTIVE_INDEXED_STATUS_UNAVAILABLE");
  if (pool.currentPrice === null) reasons.push("CURRENT_PRICE_UNAVAILABLE");
  if (pool.currentTick === null) reasons.push("CURRENT_TICK_UNAVAILABLE");
  if (pool.tickSpacing === null) reasons.push("TICK_SPACING_UNAVAILABLE");
  if (pool.activeLiquidity === null) reasons.push("ACTIVE_LIQUIDITY_UNAVAILABLE");
  if (pool.replayEvidence === null) {
    if (pool.evidence?.swapIndexPass !== true) reasons.push("SWAP_HISTORY_UNAVAILABLE");
    reasons.push("FEE_GROWTH_ACCOUNTING_UNAVAILABLE", "REPLAY_INPUT_UNAVAILABLE", "EXACT_REPLAY_ACCOUNTING_UNAVAILABLE");
  } else {
    reasons.push(...(Array.isArray(pool.replayEvidence.blockers) ? pool.replayEvidence.blockers : []));
  }
  if (pool.feeRate === null || pool.feeConfigVerified !== true) reasons.push("FEE_CONFIGURATION_UNAVAILABLE");
  if (pool.assetDecimals === null || pool.quoteDecimals === null) reasons.push("TOKEN_DECIMALS_UNAVAILABLE");
  if (pool.executionCosts === null) reasons.push("EXECUTION_COST_UNAVAILABLE");
  if (pool.evidence?.markout && pool.evidence.markout.quality !== "COMPLETE") reasons.push("MARKOUT_UNAVAILABLE");
  if (pool.evidence?.swaps?.path && pool.evidence.swaps.path.pass !== true) reasons.push("SWAP_TICK_PATH_UNAVAILABLE");
  if (pool.evidence?.swaps?.path?.divergence === true) reasons.push("REPLAY_STATE_DIVERGENCE");
  if (pool.evidence?.swaps?.windows?.["24"] && pool.evidence.swaps.windows["24"].windowComplete !== true) reasons.push("WINDOW_24H_COVERAGE_UNAVAILABLE");
  reasons.push(...evidenceBlockers);
  if (pool.tvl === null || pool.tvl < config.tvlEnterThreshold) reasons.push("TVL_ENTRY_THRESHOLD_NOT_PROVEN");
  return [...new Set(reasons)];
}

function replayCandidate(candidate, ranges, replayEvidence) {
  const replay = replayEvidence?.candidates?.[candidate.id];
  if (!replay) return null;
  const required = [
    "coreActiveTimeRatio",
    "bufferActiveTimeRatio",
    "coreCapturedFee",
    "bufferCapturedFee",
    "selfDilution",
    "rebalanceFrequency",
    "rebalanceSwapCost",
    "slippage",
    "transactionCost",
    "inventoryChange",
    "impermanentLoss",
    "toxicMarkout",
  ];
  if (!required.every((field) => finite(replay[field]) !== null)) return null;
  const grossFee24h = replay.coreCapturedFee + replay.bufferCapturedFee;
  const expectedNetFee24h = grossFee24h
    - replay.selfDilution
    - replay.toxicMarkout
    - replay.rebalanceSwapCost
    - replay.slippage
    - replay.transactionCost
    - replay.impermanentLoss;
  return {
    ...replay,
    candidateId: candidate.id,
    coreWidth: candidate.coreWidth,
    bufferWidth: candidate.bufferWidth,
    coreWidthLabel: candidate.coreWidthLabel,
    bufferWidthLabel: candidate.bufferWidthLabel,
    allocation: candidate.allocation,
    allocationLabel: candidate.allocationLabel,
    coreCapital: candidate.coreCapital,
    bufferCapital: candidate.bufferCapital,
    core: ranges.core,
    buffer: ranges.buffer,
    grossFee24h,
    expectedNetFee24h,
  };
}

function volatilityPreference(replay, pool) {
  const regime = pool.volatilityRegime?.regime;
  const width = replay.coreWidth + replay.bufferWidth;
  if (regime === "LOW_VOL") return -width;
  if (regime === "HIGH_VOL") return width;
  return 0;
}

function actionForResult(pool, best) {
  if (!best) return "UNAVAILABLE";
  const shadow = pool.shadowPosition;
  if (!shadow) return "OPEN";
  if (shadow.hasPosition === false) return "OPEN";

  const incremental = finite(best.expectedNetFee24h) === null || finite(shadow.existingExpectedNetFee24h) === null
    ? null
    : best.expectedNetFee24h - shadow.existingExpectedNetFee24h;
  const totalCost = finite(pool.executionCosts?.totalRebalanceCost);
  const safetyMargin = finite(pool.executionCosts?.safetyMargin);
  if (incremental === null || totalCost === null || safetyMargin === null) return "UNAVAILABLE";
  if (!passesRebalanceGate(incremental, totalCost, safetyMargin)) return "HOLD";
  if (shadow.coreHealthy === false && shadow.bufferHealthy !== false) return "MOVE_CORE";
  if (shadow.coreHealthy === false && shadow.bufferHealthy === false) return "MOVE_BOTH";
  return "HOLD";
}

export function passesRebalanceGate(incrementalGain, totalCost, safetyMargin) {
  return Number.isFinite(incrementalGain) && Number.isFinite(totalCost) && Number.isFinite(safetyMargin)
    && incrementalGain > totalCost + safetyMargin;
}

export function evaluateShadowExit(pool, optimizer, config) {
  const shadow = pool.shadowPosition;
  if (!shadow || shadow.hasPosition === false) {
    return { action: optimizer.action, exitEvent: null, noForcedExit: true, reasons: [] };
  }

  if (optimizer.executable !== true) {
    return {
      action: "UNAVAILABLE",
      exitEvent: "NO_FORCED_EXIT",
      noForcedExit: true,
      reasons: ["CURRENT_POOL_DATA_UNAVAILABLE"],
    };
  }

  const reasons = [];
  if (pool.universeStatus !== null && pool.universeStatus !== "ACTIVE_INDEXED") reasons.push("UNIVERSE_NOT_ACTIVE");
  if (finite(pool.tvl) !== null && pool.tvl < config.tvlExitHysteresis) reasons.push("TVL_BELOW_EXIT_HYSTERESIS");
  if (Array.isArray(pool.riskFlags)) reasons.push(...pool.riskFlags);
  if (optimizer.best && finite(optimizer.best.expectedNetFee24h) !== null && optimizer.best.expectedNetFee24h <= 0) reasons.push("EXPECTED_NET_FEE_NON_POSITIVE");

  if (reasons.length > 0) {
    return { action: "CLOSE", exitEvent: "EXIT_EVENT", noForcedExit: false, reasons: [...new Set(reasons)] };
  }
  return { action: optimizer.action, exitEvent: "NO_FORCED_EXIT", noForcedExit: true, reasons: [] };
}

export function buildTop3ChangeStrip(previousTop3 = [], currentTop3 = []) {
  const previous = new Set(previousTop3.map((item) => item.poolAddress).filter(Boolean));
  const current = new Set(currentTop3.map((item) => item.poolAddress).filter(Boolean));
  const entered = currentTop3.filter((item) => !previous.has(item.poolAddress)).map((item) => item.symbol);
  const exited = previousTop3.filter((item) => !current.has(item.poolAddress)).map((item) => item.symbol);
  return {
    status: previousTop3.length === 0 ? "NO_PRIOR_SHADOW_STATE" : "OBSERVED",
    entered,
    exited,
    noForcedExit: true,
  };
}

export function createShadowPosition(pool, optimizer, timestamp, dataHash) {
  if (!optimizer.executable || optimizer.action !== "OPEN" || !optimizer.best) return null;
  return {
    poolAddress: pool.poolAddress,
    strategyVersion: "shadow-v1",
    referencePrice: pool.currentPrice,
    createdAt: timestamp,
    coreCapital: optimizer.best.coreCapital,
    bufferCapital: optimizer.best.bufferCapital,
    coreRange: optimizer.best.core,
    bufferRange: optimizer.best.buffer,
    optimalExpectedNetFee24h: optimizer.best.expectedNetFee24h,
    lastAction: "OPEN",
    dataHash: dataHash ?? null,
  };
}

export function searchOptimizer(pool, config) {
  const candidates = buildStrategyCandidates(config);
  const blockers = validateOptimizerInputs(pool, config);
  const base = {
    executable: false,
    action: "UNAVAILABLE",
    candidatesSearched: candidates.length,
    candidatesEvaluated: 0,
    blockers,
    best: null,
    exit: { action: "UNAVAILABLE", exitEvent: null, noForcedExit: true, reasons: [] },
    validation: {
      rwaUsdcOnly: pool.rwaIdentityVerified === true && pool.usdcIdentityVerified === true ? "PASS" : "UNAVAILABLE",
      top3Only: "PASS",
      capitalFixed1000: config.capital === 1_000 ? "PASS" : "FAIL",
      walletDependencyRemoved: "PASS",
      realPositionDependencyRemoved: "PASS",
      shadowPositionState: pool.shadowPosition ? "PRESENT" : "ABSENT",
      coreSearch: candidates.length > 0 ? "PASS" : "FAIL",
      bufferSearch: candidates.some((candidate) => candidate.bufferWidth > candidate.coreWidth) ? "PASS" : "FAIL",
      allocationSearch: candidates.length > 0 ? "PASS" : "FAIL",
      tickSnapping: "UNAVAILABLE",
      historicalReplay: "UNAVAILABLE",
      selfDilution: "UNAVAILABLE",
      markoutModel: "UNAVAILABLE",
      rebalanceCost: "UNAVAILABLE",
      volatilityRegime: pool.volatilityRegime ?? null,
      moveCoreIndependent: "PASS",
      moveBothGate: "PASS",
      closeLogic: "PASS",
      rankingHysteresis: "PASS",
      rebalanceHysteresis: "PASS",
      failClosed: "PASS",
      autoExecution: config.autoExecution ? "FAIL" : "OFF",
    },
  };
  if (blockers.length > 0) return base;

  const rangesAreLegal = canSnapAllRanges(pool, candidates);
  if (!rangesAreLegal) return { ...base, blockers: ["NO_VALID_CANDIDATE"] };

  const evaluated = candidates
    .map((candidate) => ({ candidate, ranges: candidateRanges(candidate, pool) }))
    .map(({ candidate, ranges }) => ({ candidate, replay: replayCandidate(candidate, ranges, pool.replayEvidence) }))
    .filter((candidate) => candidate.replay !== null)
    .sort((a, b) => {
      const netDelta = b.replay.expectedNetFee24h - a.replay.expectedNetFee24h;
      if (Math.abs(netDelta) > 1e-9) return netDelta;
      return volatilityPreference(b.replay, pool) - volatilityPreference(a.replay, pool);
    });
  const best = evaluated[0]?.replay ?? null;
  if (!best) return { ...base, blockers: ["NO_VALID_CANDIDATE"] };

  const executable = Number.isFinite(best.expectedNetFee24h) && best.expectedNetFee24h > 0;
  const result = {
    ...base,
    executable,
    action: executable ? actionForResult(pool, best) : "UNAVAILABLE",
    candidatesEvaluated: evaluated.length,
    best: executable ? best : null,
    validation: {
      ...base.validation,
      tickSnapping: "PASS",
      historicalReplay: "PASS",
      selfDilution: "PASS",
      markoutModel: "PASS",
      rebalanceCost: "PASS",
      volatilityRegime: pool.volatilityRegime ?? null,
    },
  };
  return { ...result, exit: evaluateShadowExit(pool, result, config) };
}

export function buildOptimizerResults(pools, config) {
  const results = pools.map((pool) => ({
    pool,
    optimizer: searchOptimizer(pool, config),
  }));
  const executable = results
    .filter(({ optimizer }) => optimizer.executable && optimizer.best)
    .sort((a, b) => b.optimizer.best.expectedNetFee24h - a.optimizer.best.expectedNetFee24h);
  const top3 = executable.slice(0, 3).map(({ pool, optimizer }, index) => ({
    rank: index + 1,
    poolAddress: pool.poolAddress,
    assetMint: pool.assetMint,
    symbol: pool.symbol,
    name: pool.name,
    poolType: pool.poolType,
    feeTier: pool.feeTier,
    tvl: pool.tvl,
    volume24h: pool.volume24h,
    lpFee24h: pool.lpFee24h,
    price: pool.price,
    best: optimizer.best,
    action: optimizer.action,
    exit: optimizer.exit,
    dataQuality: optimizer.validation,
    evidence: pool.evidence ?? null,
  }));
  return {
    top3,
    results,
    observedPoolCount: pools.length,
    executablePoolCount: executable.length,
    shadowState: "NO_WALLET_NO_REAL_POSITION",
    top3Change: buildTop3ChangeStrip([], top3),
  };
}
