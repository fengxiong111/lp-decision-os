import type { StoredSwitchSignal } from "@/services/storage/event-index";

export type SwitchEvaluationInput = {
  pairId: string;
  fromPool: string | null;
  toPool: string | null;
  candidateAdvantage: number | null;
  feeAcceleration: number | null;
  volumeAcceleration: number | null;
  routeShift: number | null;
  dataFresh: boolean;
  now: string;
  projectionVersion: number;
};

export function signalId(pairId: string, fromPool: string | null, toPool: string | null): string {
  return `${pairId}:${fromPool ?? "none"}:${toPool ?? "none"}`;
}

export function advanceSwitchSignal(previous: StoredSwitchSignal | null, input: SwitchEvaluationInput): StoredSwitchSignal {
  const nowMs = Date.parse(input.now);
  const previousStart = previous?.startedAt ?? input.now;
  const durationMs = Math.max(0, nowMs - Date.parse(previousStart));
  const advantage = input.candidateAdvantage;
  const invalid = !input.dataFresh || advantage === null || !Number.isFinite(advantage);
  let state: StoredSwitchSignal["state"] = previous?.state ?? "NONE";
  let confirmedAt = previous?.confirmedAt ?? null;
  let invalidatedAt = previous?.invalidatedAt ?? null;
  let startedAt = previous?.startedAt ?? input.now;
  const reason: string[] = [];

  if (invalid) {
    state = previous && previous.state !== "NONE" ? "INVALIDATED" : "NONE";
    if (state === "INVALIDATED") invalidatedAt = input.now;
    reason.push(!input.dataFresh ? "数据新鲜度不足" : "候选优势暂无有效值");
  } else if (advantage < 0.2) {
    state = previous?.state === "CONFIRMED" ? "COOLDOWN" : "NONE";
    reason.push("候选预计手续费优势低于20%阈值");
    startedAt = state === "NONE" ? input.now : startedAt;
  } else if (advantage >= 0.3 && durationMs >= 30 * 60_000 && input.dataFresh) {
    state = "CONFIRMED";
    confirmedAt = previous?.confirmedAt ?? input.now;
    reason.push("候选优势至少30%且持续30分钟");
  } else {
    state = "WATCHING";
    if (!previous || previous.state === "NONE" || previous.state === "INVALIDATED") startedAt = input.now;
    reason.push("候选预计手续费优势至少20%，等待持续确认");
  }

  return {
    signalId: signalId(input.pairId, input.fromPool, input.toPool),
    pairId: input.pairId,
    fromPool: input.fromPool,
    toPool: input.toPool,
    state,
    score: advantage === null ? null : Math.max(0, Math.min(100, advantage * 100)),
    reason: [
      ...reason,
      ...(input.feeAcceleration === null ? ["手续费加速度等待窗口"] : [`手续费加速度 ${(input.feeAcceleration * 100).toFixed(1)}%`]),
      ...(input.volumeAcceleration === null ? ["成交加速度等待窗口"] : [`成交加速度 ${(input.volumeAcceleration * 100).toFixed(1)}%`]),
      ...(input.routeShift === null ? ["Route Share 位移等待窗口"] : [`Route Share 位移 ${(input.routeShift * 100).toFixed(1)}%`]),
    ],
    startedAt,
    confirmedAt,
    invalidatedAt,
    lastSeenAt: input.now,
    projectionVersion: input.projectionVersion,
  };
}

