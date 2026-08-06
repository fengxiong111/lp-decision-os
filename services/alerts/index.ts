import type { DashboardSnapshot } from "@/packages/models/src";

export function buildLiveAlerts(snapshot: DashboardSnapshot): string[] {
  const alerts = [...snapshot.discovery.errors];
  if (snapshot.session.state !== "盘中") alerts.push("美股市场当前不在盘中，价格发现置信度已下调");
  if (snapshot.rpc.slotLag !== null && snapshot.rpc.slotLag > 32) alerts.push(`Solana slot 落后 ${snapshot.rpc.slotLag}`);
  if (snapshot.websocket.status !== "在线") alerts.push("Solana WebSocket 未在线");
  return [...new Set(alerts)].slice(0, 8);
}
