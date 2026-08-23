import { finite } from "./pool-schema.mjs";
import { replayForStrategy } from "./strategy-engine.mjs";

const REQUIRED_RISK_FIELDS = Object.freeze([
  "grossFee24h",
  "outOfRangeTimeCost",
  "rebalanceCost",
  "gasCost",
  "swapSlippage",
  "impermanentLoss",
]);

function riskLevelFor(model) {
  if (model.status !== "COMPLETE" || model.grossFee24h <= 0) return "UNVERIFIED";
  const cost = model.outOfRangeTimeCost + model.rebalanceCost + model.gasCost + model.swapSlippage + model.impermanentLoss;
  const costRatio = cost / model.grossFee24h;
  if (costRatio >= 0.5) return "HIGH";
  if (costRatio >= 0.2) return "MEDIUM";
  return "LOW";
}

function waitingRisk(reason = "REPLAY_REQUIRED") {
  return {
    status: "WAITING_REPLAY",
    riskLevel: "UNVERIFIED",
    reason,
    grossFee24h: null,
    outOfRangeTimeCost: null,
    rebalanceCost: null,
    gasCost: null,
    swapSlippage: null,
    impermanentLoss: null,
    expectedNetReturn: null,
    rebalanceFrequency: null,
    confidence: null,
  };
}

export function evaluateRisk(replay) {
  if (!replay || !REQUIRED_RISK_FIELDS.every((key) => finite(replay[key]) !== null)) return waitingRisk();
  const expectedNetReturn = replay.grossFee24h
    - replay.outOfRangeTimeCost
    - replay.rebalanceCost
    - replay.gasCost
    - replay.swapSlippage
    - replay.impermanentLoss;
  const model = {
    status: Number.isFinite(expectedNetReturn) ? "COMPLETE" : "WAITING_REPLAY",
    riskLevel: "UNVERIFIED",
    reason: null,
    grossFee24h: replay.grossFee24h,
    outOfRangeTimeCost: replay.outOfRangeTimeCost,
    rebalanceCost: replay.rebalanceCost,
    gasCost: replay.gasCost,
    swapSlippage: replay.swapSlippage,
    impermanentLoss: replay.impermanentLoss,
    expectedNetReturn: Number.isFinite(expectedNetReturn) ? expectedNetReturn : null,
    rebalanceFrequency: finite(replay.rebalanceFrequency),
    confidence: finite(replay.confidence),
  };
  model.riskLevel = riskLevelFor(model);
  if (model.status !== "COMPLETE") return waitingRisk("RISK_CALCULATION_INVALID");
  return model;
}

export class RiskEngine {
  evaluate(pool, strategy) {
    return evaluateRisk(replayForStrategy(pool, strategy));
  }
}
