export type Nullable<T> = T | null;

export type BlockedReason =
  | "BLOCKED_AUTH"
  | "BLOCKED_SOURCE_UNAVAILABLE"
  | "BLOCKED_INSUFFICIENT_HISTORY"
  | "BLOCKED_UNSUPPORTED_CHAIN"
  | "BLOCKED_MISSING_PRICE";

export type SourceStatus = "READY" | "BLOCKED" | "UNAVAILABLE";

export type SourceArtifact = {
  source: "okx" | "uniswap" | "geckoterminal" | "dexscreener" | "rpc";
  status: SourceStatus;
  fetchedAt: string;
  chainId: Nullable<string>;
  tokenAddress: string;
  payload: unknown;
  blockedReasons: BlockedReason[];
  error: Nullable<string>;
};

export type RangeCandidate = {
  kind: "CORE" | "BUFFER";
  lowerPriceUsd: Nullable<number>;
  upperPriceUsd: Nullable<number>;
  widthPct: Nullable<number>;
  score: Nullable<number>;
  replay: { sampleHours: Nullable<number>; observedVolumeUsd: Nullable<number>; feeProxyUsd: Nullable<number> };
  blockedReasons: BlockedReason[];
};

export type AnalysisResult = {
  schemaVersion: "lp-oracle-v3.0";
  analyzedAt: string;
  request: { address: string; chain: Nullable<string> };
  token: { name: Nullable<string>; symbol: Nullable<string>; priceUsd: Nullable<number>; marketCapUsd: Nullable<number> };
  authority: { primary: Nullable<string>; confidence: Nullable<number>; notes: string[] };
  sources: SourceArtifact[];
  candidates: RangeCandidate[];
  decision: { action: "ENTER" | "WAIT" | "HOLD"; selected: Nullable<"CORE" | "BUFFER">; score: Nullable<number>; blockedReasons: BlockedReason[] };
};
