import DashboardClient from "@/app/dashboard-client";
import { buildRankingResponse } from "@/services/rankings";
import { getDashboardSnapshot } from "@/services/raydium/snapshot";

export const dynamic = "force-dynamic";

export default async function Page() {
  const snapshot = await getDashboardSnapshot();
  return <DashboardClient initialSnapshot={snapshot} initialRanking={buildRankingResponse(snapshot, 1_000, "24h")} />;
}
