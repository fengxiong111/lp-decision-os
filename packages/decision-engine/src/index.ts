export type SwitchSignalState = "NONE" | "WATCHING" | "CONFIRMED" | "COOLDOWN" | "INVALIDATED";

export type SwitchSignal = {
  pairId: string;
  fromPool: string | null;
  toPool: string | null;
  state: SwitchSignalState;
  score: number | null;
  startedAt: string | null;
  confirmedAt: string | null;
  invalidatedAt: string | null;
};

