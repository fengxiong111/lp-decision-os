import type { AnalysisResult, RangeCandidate, SourceArtifact } from "../schema/types";

const n = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
type Pair = { priceUsd?: string | number; marketCap?: string | number; baseToken?: { name?: string; symbol?: string }; volume?: Record<string, string | number> };
function pick(source: SourceArtifact): Pair | null {
  if (source.source === "dexscreener") return ((source.payload as { pair?: Pair } | null)?.pair ?? null);
  return null;
}
function candidate(kind: RangeCandidate["kind"], price: number | null, pair: Pair | null): RangeCandidate {
  const width = kind === "CORE" ? 0.12 : 0.30;
  const h1 = n(pair?.volume?.h1), h6 = n(pair?.volume?.h6), h24 = n(pair?.volume?.h24);
  const sampleHours = h24 !== null ? 24 : h6 !== null ? 6 : h1 !== null ? 1 : null;
  const observedVolumeUsd = h24 ?? h6 ?? h1;
  const feeProxyUsd = observedVolumeUsd === null ? null : observedVolumeUsd * 0.003;
  const score = price !== null && observedVolumeUsd !== null ? Math.min(100, Math.round(50 + Math.log10(Math.max(1, observedVolumeUsd)) * 8 - width * 30)) : null;
  return { kind, lowerPriceUsd: price === null ? null : price * (1 - width), upperPriceUsd: price === null ? null : price * (1 + width), widthPct: width * 100, score, replay: { sampleHours, observedVolumeUsd, feeProxyUsd }, blockedReasons: sampleHours === null ? ["BLOCKED_INSUFFICIENT_HISTORY"] : price === null ? ["BLOCKED_MISSING_PRICE"] : [] };
}

export function buildAnalysis(address: string, sources: SourceArtifact[], analyzedAt = new Date().toISOString()): AnalysisResult {
  const dex = sources.find((source) => source.source === "dexscreener" && source.status === "READY");
  const pair = dex ? pick(dex) : null;
  const price = n(pair?.priceUsd), volume = n(pair?.volume?.h24);
  const candidates = [candidate("CORE", price, pair), candidate("BUFFER", price, pair)];
  const blockedReasons = [...new Set(sources.flatMap((source) => source.blockedReasons).concat(candidates.flatMap((row) => row.blockedReasons)))];
  const selected = candidates.find((row) => row.score !== null)?.kind ?? null;
  return { schemaVersion: "lp-oracle-v3.0", analyzedAt, request: { address, chain: dex?.chainId ?? null }, token: { name: pair?.baseToken?.name ?? null, symbol: pair?.baseToken?.symbol ?? null, priceUsd: price, marketCapUsd: n(pair?.marketCap) }, authority: { primary: dex ? "dexscreener" : null, confidence: dex ? 0.55 : null, notes: ["官方/链上适配器优先；本次使用公开 fallback。", "区间是候选建议，不是已完成 Tick/IL/执行成本仿真。"] }, sources, candidates, decision: { action: selected ? "WAIT" : "HOLD", selected, score: selected ? candidates.find((row) => row.kind === selected)?.score ?? null : null, blockedReasons: volume === null ? blockedReasons.concat("BLOCKED_INSUFFICIENT_HISTORY") : blockedReasons } };
}
