import type { PoolVerification, QualitySnapshot, ServiceHealth, SourceRef } from "@/packages/models/src";

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

export function calculatePoolQuality(input: {
  verification: PoolVerification;
  apiAvailable: boolean;
  tickAvailable: boolean;
  websocket: ServiceHealth;
  apiAgeSeconds: number | null;
  rpcSlotLag: number | null;
  swapSampleCount: number;
  windowCoverageCount: number;
  scannedForEvents: boolean;
  sessionAdjustment: number;
  sources: SourceRef[];
}): QualitySnapshot {
  const apiFreshness = input.apiAgeSeconds === null ? 45 : input.apiAgeSeconds <= 120 ? 100 : input.apiAgeSeconds <= 300 ? 90 : input.apiAgeSeconds <= 900 ? 75 : 50;
  const rpcFreshness = input.rpcSlotLag === null ? 45 : input.rpcSlotLag <= 100 ? 100 : input.rpcSlotLag <= 300 ? 85 : input.rpcSlotLag <= 900 ? 65 : 40;
  const swapQuality = input.swapSampleCount >= 5 ? 100 : input.swapSampleCount >= 2 ? 90 : input.swapSampleCount === 1 ? 78 : input.scannedForEvents ? 52 : 38;
  const windowQuality = input.windowCoverageCount >= 4 ? 100 : input.windowCoverageCount >= 2 ? 82 : input.windowCoverageCount === 1 ? 68 : 45;
  const metricScores: Record<string, number | null> = {
    tvl: input.verification.poolAccountExists && input.verification.programVerified ? 100 : null,
    fee: input.apiAvailable ? apiFreshness : null,
    volume: input.apiAvailable ? swapQuality : null,
    tick: input.tickAvailable ? 100 : null,
    websocket: input.websocket.status === "在线" ? 100 : input.websocket.status === "降级" ? 60 : null,
    reconciliation: input.verification.mintsVerified && input.verification.vaultsVerified ? 100 : 55,
    rpcFreshness,
    eventWindows: windowQuality,
  };
  const weighted = [
    [metricScores.tvl, 0.2],
    [metricScores.fee, 0.12],
    [metricScores.volume, 0.18],
    [metricScores.tick, 0.12],
    [metricScores.websocket, 0.05],
    [metricScores.reconciliation, 0.16],
    [metricScores.rpcFreshness, 0.08],
    [metricScores.eventWindows, 0.09],
  ];
  const available = weighted.filter(([score]) => score !== null) as [number, number][];
  const denominator = available.reduce((total, [, weight]) => total + weight, 0);
  const baseScore = denominator === 0 ? null : available.reduce((total, [score, weight]) => total + score * weight, 0) / denominator;
  const score = baseScore === null ? null : clamp(baseScore + input.sessionAdjustment);
  const reasons: string[] = [];
  if (!input.verification.programVerified) reasons.push("RPC 未确认 Raydium Program ID");
  if (!input.verification.mintsVerified) reasons.push("Mint 账户未完成链上复核");
  if (!input.verification.vaultsVerified) reasons.push("Vault 账户未完成链上复核");
  if (!input.tickAvailable) reasons.push("尚未形成 Tick 数据");
  if (input.websocket.status !== "在线") reasons.push("WebSocket 尚未确认");
  if (input.swapSampleCount === 0) reasons.push(input.scannedForEvents ? "已回补该池但尚未找到 Swap 样本" : "该池尚未进入事件回补队列");
  else if (input.swapSampleCount < 3) reasons.push(`仅有 ${input.swapSampleCount} 笔可验证 Swap 样本`);
  if (input.apiAgeSeconds !== null && input.apiAgeSeconds > 300) reasons.push(`API 数据已 ${Math.round(input.apiAgeSeconds / 60)} 分钟未刷新`);
  if (input.rpcSlotLag !== null && input.rpcSlotLag > 300) reasons.push(`RPC Slot Lag ${input.rpcSlotLag}`);
  if (input.windowCoverageCount < 2) reasons.push("短窗口事件覆盖不足");
  if (input.sessionAdjustment < 0) reasons.push("美股当前非盘中，降低价格发现置信度");

  const status = !input.verification.poolAccountExists || !input.verification.programVerified
    ? "blocked"
    : score !== null && score >= 90 && reasons.length === 0
      ? "verified"
      : "degraded";
  return {
    score,
    status,
    reasons,
    metricScores,
    details: {
      poolAccount: input.verification.poolAccountExists ? "已存在" : "缺失",
      program: input.verification.programVerified ? "已核验" : "未核验",
      vaults: input.verification.vaultsVerified ? "已核验" : "未核验",
      apiAgeSeconds: input.apiAgeSeconds,
      rpcSlotLag: input.rpcSlotLag,
      swapSampleCount: input.swapSampleCount,
      windowCoverageCount: input.windowCoverageCount,
      eventScan: input.scannedForEvents ? "已扫描" : "未扫描",
    },
    sources: input.sources,
  };
}

export function aggregateQuality(qualities: QualitySnapshot[]): QualitySnapshot {
  const valid = qualities.map((quality) => quality.score).filter((score): score is number => score !== null);
  const score = valid.length === 0 ? null : clamp(valid.reduce((total, item) => total + item, 0) / valid.length);
  const reasons = [...new Set(qualities.flatMap((quality) => quality.reasons))].slice(0, 8);
  const sources = [...new Map(qualities.flatMap((quality) => quality.sources).map((source) => [source.url, source])).values()];
  return {
    score,
    status: score === null ? "blocked" : score >= 90 && reasons.length === 0 ? "verified" : "degraded",
    reasons,
    metricScores: {
      TVL: score,
      费用: score,
      成交量: score,
      RPC: score,
      WebSocket: score,
    },
    details: {
      poolCount: qualities.length,
      verifiedPoolCount: qualities.filter((quality) => quality.status === "verified").length,
      source: "各池质量分平均值；点击单池查看扣分明细",
    },
    sources,
  };
}
