export const DECISIONS = Object.freeze(["WATCH", "CONSIDER", "ENTER"]);

export function decidePool({ strategy, simulation, risk }) {
  if (risk?.status === "COMPLETE" && risk.expectedNetReturn !== null && risk.expectedNetReturn > 0) {
    if (strategy?.executionReady === true && ["LOW", "MEDIUM"].includes(risk.riskLevel)) {
      return { decision: "ENTER", reasonCode: "VERIFIED_NET_RETURN_AND_EXECUTION_READY", reason: "完整 Replay、风险成本和执行前置证据均已通过" };
    }
    return { decision: "CONSIDER", reasonCode: "VERIFIED_NET_RETURN_EXECUTION_PENDING", reason: "净收益已通过 Replay，但执行前置证据仍待完成" };
  }
  if (simulation?.status === "SIMULATED") {
    return { decision: "CONSIDER", reasonCode: "SIMULATED_GROSS_ONLY", reason: "市场数据与策略模拟可用，净收益等待完整 Replay" };
  }
  return { decision: "WATCH", reasonCode: "MARKET_OR_RISK_EVIDENCE_WAITING", reason: "市场或风险证据不足，暂不形成建仓结论" };
}

export class DecisionEngine {
  decide(input) {
    return decidePool(input);
  }
}
