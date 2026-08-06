import { USDC_MINT } from "@/services/raydium/config";
import type { CalibrationRegressionCase, PoolSnapshot, PositionSnapshot } from "@/packages/models/src";

// 目标身份来自 Raydium RWA 池发现结果；回归匹配同时要求 Mint、Quote Mint、Pool Address 和费率。
const REGRESSION_TARGETS = [
  { label: "SPCX/USDC 0.25%", baseMint: "SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb", feeRate: 0.0025 },
  { label: "SPCXx/USDC 0.8%", baseMint: "Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8", feeRate: 0.008 },
] as const;

const variantFormulas: Record<string, string> = {
  A: "实际资本 × 实际 Tick 区间 × 实际预测周期",
  B: "$1,000 标准化资本 × 实际 Tick 区间 × 实际预测周期",
  C: "实际资本 × 相同相对区间宽度 × 实际预测周期",
  D: "实际资本 × 实际 Tick 区间 × 相同预测周期",
  E: "预测手续费 − 执行成本 − IL（不含风险扣分）",
  F: "预测手续费 − 执行成本 − IL − 风险扣分",
};

function blockedVariants() {
  return Object.fromEntries(Object.entries(variantFormulas).map(([key, formula]) => [key, {
    formula,
    rank: null,
    score: null,
    status: "BLOCKED" as const,
  }])) as CalibrationRegressionCase["variants"];
}

export function buildCalibrationRegressionCases(pools: PoolSnapshot[], positions: PositionSnapshot[]): CalibrationRegressionCase[] {
  return REGRESSION_TARGETS.map((target) => {
    const candidates = pools.filter((pool) => pool.identity.baseMint === target.baseMint && pool.identity.quoteMint === USDC_MINT && pool.feeRate !== null && Math.abs(pool.feeRate - target.feeRate) < 1e-9);
    const pool = candidates.length === 1 ? candidates[0] : null;
    const position = pool ? positions.find((item) => item.poolAddress === pool.id) : undefined;
    const blockers = [
      ...(candidates.length === 0 ? ["当前可信池集合中没有精确匹配的 Base Mint + Quote Mint + Fee Tier"] : []),
      ...(candidates.length > 1 ? ["同一身份键匹配到多个 Pool Address，不能猜测选择"] : []),
      ...(position ? [] : ["未读取到该精确 Pool Address 对应的 Position NFT"]),
      ...(pool?.feeReconciliation.status === "PASS" ? [] : ["该 Pool 的逐笔 Swap LP Fee 与 fee_growth_global 尚未通过双路线对账"]),
      ...(pool?.windowCoverage["1h"].backfillStatus === "COMPLETE" && pool.windowCoverage["12h"].backfillStatus === "COMPLETE" ? [] : ["1h / 12h 交易覆盖率尚未 COMPLETE"]),
      "执行模拟、IL、滑点和迁移回本时间尚未完成",
    ];
    const metrics: CalibrationRegressionCase["metrics"] = {
      exactPoolMatchCount: candidates.length,
      poolAddress: pool?.identity.poolAddress ?? null,
      baseMint: pool?.identity.baseMint ?? target.baseMint,
      quoteMint: pool?.identity.quoteMint ?? USDC_MINT,
      feeTier: pool?.feeTier ?? `${target.feeRate * 100}%`,
      tickSpacing: pool?.tickSpacing ?? null,
      currentTick: pool?.currentTick ?? null,
      userTickLower: position?.tickLower ?? null,
      userTickUpper: position?.tickUpper ?? null,
      positionValueUsd: position?.positionValueUsd ?? null,
      inRangeSeconds: position?.activeSeconds ?? null,
      actualFeeIncrementUsd: position?.uncollectedFeeUsd ?? null,
      actualFeeReturn: position?.actualFeeReturn ?? null,
      poolFeeDensity: pool?.feeDensity ?? null,
      volume24h: pool?.volume24h ?? null,
      effectiveTvl: pool?.effectiveActiveTvl ?? null,
      routeShare: pool?.routeShare ?? null,
      predictedIl: position?.impermanentLoss ?? null,
      expectedExitCost: null,
      predictedNetYield: pool?.expectedNetYield ?? null,
      riskPenalty: pool?.confidence === null || pool?.confidence === undefined ? null : 1 - pool.confidence / 100,
    };
    return {
      label: target.label,
      targetBaseMint: target.baseMint,
      quoteMint: USDC_MINT,
      feeTier: `${target.feeRate * 100}%`,
      poolAddress: pool?.identity.poolAddress ?? null,
      positionNftMint: position?.positionNftMint ?? null,
      status: blockers.length === 0 ? "PASS" : "BLOCKED",
      metrics,
      variants: blockedVariants(),
      blockers,
      explanation: blockers.length === 0 ? "回归输入完整，等待排名变体计算。" : "当前不能用数字证明第 1 与第 21 的差异；任何继续输出的综合名次都视为算法缺陷。",
    };
  });
}
