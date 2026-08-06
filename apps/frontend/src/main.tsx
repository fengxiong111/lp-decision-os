import React from "react";
import { createRoot } from "react-dom/client";
import DashboardClient from "@/app/dashboard-client";
import "@/app/globals.css";

type ProjectionPayload = {
  snapshot?: Parameters<typeof DashboardClient>[0]["initialSnapshot"];
  rankings?: Record<string, Record<string, Parameters<typeof DashboardClient>[0]["initialRanking"]>>;
};

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} ${response.status}`);
  return await response.json() as T;
}

function Loading() {
  return <main className="terminal-shell"><div className="terminal-empty">正在读取本地 MarketProjection<small>后端启动后将从 SQLite 快照恢复，不依赖页面触发回补</small></div></main>;
}

function Failure({ error }: { error: string }) {
  return <main className="terminal-shell"><div className="terminal-empty">本地后端尚未提供可用投影<small>{error} · 请保持 backend、indexer、backfill、metrics 进程运行</small></div></main>;
}

function FrontendRoot() {
  const [state, setState] = React.useState<{ status: "loading" | "ready" | "error"; payload?: ProjectionPayload; error?: string }>({ status: "loading" });
  React.useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const payload = await getJson<ProjectionPayload>("/api/market/snapshot");
        if (!payload.snapshot) throw new Error("MarketProjection.snapshot 缺失");
        const ranking = await getJson<Parameters<typeof DashboardClient>[0]["initialRanking"]>("/api/rankings?capital=1000&window=24h");
        if (!disposed) setState({ status: "ready", payload: { ...payload, rankings: { "1000": { "24h": ranking } } } });
      } catch (error) {
        if (!disposed) setState({ status: "error", error: error instanceof Error ? error.message : "读取后端投影失败" });
      }
    };
    void load();
    return () => { disposed = true; };
  }, []);

  React.useEffect(() => {
    if (state.status !== "ready") return;
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${location.host}/stream`);
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as { payload?: ProjectionPayload };
        if (message.payload?.snapshot) setState({ status: "ready", payload: message.payload });
      } catch {
        // 单条增量损坏不影响下一次快照。
      }
    };
    return () => socket.close();
  }, [state.status]);

  if (state.status === "loading") return <Loading />;
  if (state.status === "error" || !state.payload?.snapshot) return <Failure error={state.error ?? "MarketProjection 不可用"} />;
  const ranking = state.payload.rankings?.["1000"]?.["24h"];
  if (!ranking) return <Failure error="1000U / 24h 排名投影缺失" />;
  return <DashboardClient initialSnapshot={state.payload.snapshot} initialRanking={ranking} />;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><FrontendRoot /></React.StrictMode>);

