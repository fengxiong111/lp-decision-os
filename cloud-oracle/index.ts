import { fetchDexScreener, fetchGecko, fetchOptionalAuthSources } from "./adapters/public";
import { buildAnalysis } from "./analytics/engine";
export async function analyzeToken(address: string) {
  const [dex, gecko, optional] = await Promise.all([fetchDexScreener(address), fetchGecko(address), fetchOptionalAuthSources(address)]);
  return buildAnalysis(address, [optional[0], optional[1], optional[2], gecko, dex]);
}
