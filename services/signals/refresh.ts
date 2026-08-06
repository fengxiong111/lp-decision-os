import type { MarketProjection } from "@/services/projection/market";
import { advanceSwitchSignal } from "@/services/signals/switch";
import { persistSwitchSignal, readSwitchSignals } from "@/services/storage/event-index";

/**
 * Signals are position-aware by design. Public mode can rank candidates but
 * cannot claim a migration without a current Pool to migrate from.
 */
export function refreshSwitchSignals(projection: MarketProjection): void {
  const positionsByPool = new Map<string, string>();
  for (const position of projection.snapshot.positions) positionsByPool.set(position.poolAddress, position.positionNftMint);
  if (positionsByPool.size === 0) return;
  const ranking = projection.rankings["1000"]["12h"];
  const previous = readSwitchSignals(500);
  for (const pair of ranking.pairs) {
    const current = pair.allPools.find((pool) => positionsByPool.has(pool.poolAddress));
    const candidate = pair.recommendedPool;
    if (!current || !candidate || current.poolAddress === candidate.poolAddress) continue;
    const currentFee = current.estimatedFeeIncome.value;
    const candidateFee = candidate.estimatedFeeIncome.value;
    const candidateAdvantage = currentFee !== null && currentFee > 0 && candidateFee !== null ? (candidateFee - currentFee) / currentFee : null;
    const old = previous.find((item) => item.pairId === pair.pairId && item.fromPool === current.poolAddress && item.toPool === candidate.poolAddress) ?? null;
    const signal = advanceSwitchSignal(old, {
      pairId: pair.pairId,
      fromPool: current.poolAddress,
      toPool: candidate.poolAddress,
      candidateAdvantage,
      feeAcceleration: null,
      volumeAcceleration: null,
      routeShift: null,
      dataFresh: pair.coverage.status !== "UNAVAILABLE" && pair.coverage.status !== "BACKFILLING",
      now: projection.updatedAt,
      projectionVersion: projection.projectionVersion,
    });
    persistSwitchSignal(signal);
  }
}

