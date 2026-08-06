import { getDashboardSnapshot } from "@/services/raydium/snapshot";
import { buildRankingResponse, parseTerminalCapital, parseTerminalWindow } from "@/services/rankings";
import { jsonWithNullSemantics } from "@/services/shared/null-semantics";

export const dynamic = "force-dynamic";

const rankingCache = new Map<string, { expiresAt: number; payload: ReturnType<typeof buildRankingResponse> }>();

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const capital = parseTerminalCapital(params.get("capital"));
  const window = parseTerminalWindow(params.get("window"));
  const cacheKey = `${capital}:${window}`;
  const cached = rankingCache.get(cacheKey);
  const response = cached && cached.expiresAt > Date.now()
    ? cached.payload
    : buildRankingResponse(await getDashboardSnapshot(), capital, window);
  if (!cached || cached.expiresAt <= Date.now()) rankingCache.set(cacheKey, { expiresAt: Date.now() + 500, payload: response });
  return jsonWithNullSemantics(response, {
    headers: {
      "cache-control": "private, max-age=0.5, stale-while-revalidate=15",
      "x-ranking-basis": response.rankingBasis,
      "x-window-state": response.windowStatus.status,
      "x-data-version": response.dataVersion,
    },
  });
}
