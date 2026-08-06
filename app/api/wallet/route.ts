import { collectDashboardSnapshot, clearDashboardSnapshotCache, getLatestDashboardSnapshot } from "@/services/raydium/snapshot";
import { getConfiguredReadOnlyAddress, removeReadOnlyAddress, saveReadOnlyAddress } from "@/services/wallet/config";
import { jsonWithNullSemantics } from "@/services/shared/null-semantics";

export const dynamic = "force-dynamic";

function walletPayload(snapshot?: Awaited<ReturnType<typeof collectDashboardSnapshot>>, scanning = false) {
  const address = getConfiguredReadOnlyAddress();
  return {
    configured: Boolean(address),
    address,
    readOnly: true,
    positionCount: snapshot?.positions.length ?? 0,
    scannedAt: snapshot?.generatedAt ?? null,
    scanning,
  };
}

export async function GET() {
  return jsonWithNullSemantics({ wallet: walletPayload() }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonWithNullSemantics({ error: "请求格式无效" }, { status: 400 });
  }
  const address = typeof body === "object" && body !== null && "address" in body ? (body as { address?: unknown }).address : null;
  const saved = saveReadOnlyAddress(address);
  if ("error" in saved) return jsonWithNullSemantics({ error: saved.error }, { status: 400 });
  const previous = await collectDashboardSnapshot(false);
  const immediate = {
    ...previous,
    wallet: { configured: true, address: saved.address, readOnly: true as const },
    statusReport: { ...previous.statusReport, WALLET_POSITION_STATUS: "WALLET_POSITION_SCANNING" },
  };
  clearDashboardSnapshotCache();
  void collectDashboardSnapshot(true).catch(() => undefined);
  return jsonWithNullSemantics({ wallet: walletPayload(immediate, true), snapshot: immediate }, { status: 202, headers: { "cache-control": "no-store" } });
}

export async function DELETE() {
  removeReadOnlyAddress();
  const previous = getLatestDashboardSnapshot();
  const immediate = previous ? {
    ...previous,
    wallet: { configured: false, address: null, readOnly: true as const },
    positions: [],
    calibration: {
      ...previous.calibration,
      walletAddress: null,
      walletConfigured: false,
      positionsDiscovered: 0,
      regressionCases: [],
    },
    statusReport: { ...previous.statusReport, WALLET_POSITION_STATUS: "WALLET_POSITION_OPTIONAL_NOT_CONFIGURED" },
  } : null;
  clearDashboardSnapshotCache();
  void collectDashboardSnapshot(true).catch(() => undefined);
  return jsonWithNullSemantics({ wallet: walletPayload(immediate ?? undefined), ...(immediate ? { snapshot: immediate } : {}) }, { headers: { "cache-control": "no-store" } });
}
