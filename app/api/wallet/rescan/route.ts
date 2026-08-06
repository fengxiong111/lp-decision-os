import { collectDashboardSnapshot, clearDashboardSnapshotCache } from "@/services/raydium/snapshot";
import { getConfiguredReadOnlyAddress } from "@/services/wallet/config";
import { jsonWithNullSemantics } from "@/services/shared/null-semantics";

export const dynamic = "force-dynamic";

export async function POST() {
  if (!getConfiguredReadOnlyAddress()) return jsonWithNullSemantics({ error: "尚未添加只读钱包地址" }, { status: 400 });
  clearDashboardSnapshotCache();
  const snapshot = await collectDashboardSnapshot(true);
  return jsonWithNullSemantics({ wallet: { configured: true, address: getConfiguredReadOnlyAddress(), readOnly: true, positionCount: snapshot.positions.length, scannedAt: snapshot.generatedAt }, snapshot }, { headers: { "cache-control": "no-store" } });
}
