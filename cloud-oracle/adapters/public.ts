import type { SourceArtifact } from "../schema/types";

const NETWORKS = ["base", "ethereum", "arbitrum", "polygon", "optimism", "bsc"];
type Pair = { chainId?: string; priceUsd?: string | number; marketCap?: string | number; baseToken?: { name?: string; symbol?: string }; volume?: Record<string, string | number>; liquidity?: { usd?: string | number } };
const now = () => new Date().toISOString();
const blocked = (source: SourceArtifact["source"], address: string, reason: SourceArtifact["blockedReasons"][number]): SourceArtifact => ({ source, status: "BLOCKED", fetchedAt: now(), chainId: null, tokenAddress: address, payload: null, blockedReasons: [reason], error: null });

async function getJson(url: string): Promise<{ data: unknown; error: string | null }> {
  try {
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(4_000) });
    if (!response.ok) return { data: null, error: `HTTP_${response.status}` };
    return { data: await response.json(), error: null };
  } catch (error) { return { data: null, error: error instanceof Error ? error.message : "FETCH_FAILED" }; }
}

export async function fetchDexScreener(address: string): Promise<SourceArtifact> {
  const result = await getJson(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
  const body = result.data && typeof result.data === "object" ? result.data as { pairs?: Pair[] } : {};
  const pairs = Array.isArray(body.pairs) ? body.pairs : [];
  if (!pairs.length) return { source: "dexscreener", status: result.error ? "UNAVAILABLE" : "BLOCKED", fetchedAt: now(), chainId: null, tokenAddress: address, payload: null, blockedReasons: result.error ? ["BLOCKED_SOURCE_UNAVAILABLE"] : ["BLOCKED_MISSING_PRICE"], error: result.error };
  const pair = pairs.find((item) => item.priceUsd && item.liquidity?.usd) ?? pairs[0];
  return { source: "dexscreener", status: "READY", fetchedAt: now(), chainId: pair.chainId ?? null, tokenAddress: address, payload: { pair }, blockedReasons: [], error: null };
}

export async function fetchGecko(address: string): Promise<SourceArtifact> {
  for (const network of NETWORKS) {
    const result = await getJson(`https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${address}/pools?page=1`);
    const body = result.data && typeof result.data === "object" ? result.data as { data?: unknown[] } : {};
    const rows = Array.isArray(body.data) ? body.data : [];
    if (rows.length) return { source: "geckoterminal", status: "READY", fetchedAt: now(), chainId: network, tokenAddress: address, payload: { pools: rows }, blockedReasons: [], error: null };
  }
  return { source: "geckoterminal", status: "UNAVAILABLE", fetchedAt: now(), chainId: null, tokenAddress: address, payload: null, blockedReasons: ["BLOCKED_SOURCE_UNAVAILABLE"], error: "NO_PUBLIC_POOL_MATCH" };
}

export async function fetchOptionalAuthSources(address: string): Promise<SourceArtifact[]> {
  const out: SourceArtifact[] = [];
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  out.push(env.OKX_API_KEY ? { source: "okx", status: "UNAVAILABLE", fetchedAt: now(), chainId: null, tokenAddress: address, payload: null, blockedReasons: ["BLOCKED_SOURCE_UNAVAILABLE"], error: "OKX_ADAPTER_REQUIRES_CONFIGURED_ENDPOINT" } : blocked("okx", address, "BLOCKED_AUTH"));
  out.push(env.UNISWAP_API_KEY ? { source: "uniswap", status: "UNAVAILABLE", fetchedAt: now(), chainId: null, tokenAddress: address, payload: null, blockedReasons: ["BLOCKED_SOURCE_UNAVAILABLE"], error: "UNISWAP_ADAPTER_REQUIRES_CONFIGURED_ENDPOINT" } : blocked("uniswap", address, "BLOCKED_AUTH"));
  out.push(env.EVM_RPC_URL ? { source: "rpc", status: "UNAVAILABLE", fetchedAt: now(), chainId: null, tokenAddress: address, payload: null, blockedReasons: ["BLOCKED_SOURCE_UNAVAILABLE"], error: "RPC_ADAPTER_REQUIRES_CHAIN_CONFIGURATION" } : blocked("rpc", address, "BLOCKED_AUTH"));
  return out;
}
