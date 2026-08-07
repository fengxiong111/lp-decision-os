import { RAYDIUM_PROGRAM_IDS } from "@/services/raydium/config";
import { getRpcProviders } from "@/services/rpc/pool";
import { persistIndexerState } from "@/services/storage/event-index";

export type ChainEvent = {
  slot: number;
  signature: string | null;
  programId: string | null;
  logs: string[];
  observedAt: string;
  sourceUrl?: string | null;
};

export type IndexerHandle = {
  stop: () => void;
  provider: string;
};

type StreamConnection = {
  stop: () => void;
  url: string;
};

type StreamStatus = {
  status: string;
  connected: number;
  configured: number;
  lastSlot: number | null;
  lastEventAt: string | null;
  gapCount: number;
  gapSlots: number;
  reconnectCount: number;
  detail: string;
};

function writeStatus(status: StreamStatus) {
  persistIndexerState("stream.status", status);
}

let activeStreamGeneration = 0;

function connectEndpoint(url: string, onEvent: (event: ChainEvent) => void, poolIds: string[], generation: number): StreamConnection {
  let stopped = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let retry = 0;
  let lastSlot: number | null = null;
  let gapCount = 0;
  let gapSlots = 0;
  let reconnectCount = 0;
  let lastEventAt: string | null = null;
  let connected = false;
  const subscriptions = new Map<number, string>();

  const publish = (status: string, detail: string) => {
    if (generation !== activeStreamGeneration) return;
    writeStatus({
      status,
      connected: connected ? 1 : 0,
      configured: 1,
      lastSlot,
      lastEventAt,
      gapCount,
      gapSlots,
      reconnectCount,
      detail,
    });
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(60_000, 1_000 * (2 ** Math.min(retry, 6)));
    retry += 1;
    reconnectCount += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delay);
  };

  const close = () => {
    connected = false;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    subscriptions.clear();
    try { socket?.close(); } catch { /* 连接已关闭 */ }
    socket = null;
  };

  const open = () => {
    if (stopped) return;
    close();
    try {
      socket = new WebSocket(url);
    } catch (error) {
      publish("RECONNECTING", error instanceof Error ? error.message : "WebSocket 初始化失败");
      scheduleReconnect();
      return;
    }
    socket.addEventListener("open", () => {
      if (!socket || stopped) return;
      connected = true;
      retry = 0;
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "slotSubscribe" }));
      const mentions = poolIds.length > 0 ? poolIds : [...RAYDIUM_PROGRAM_IDS];
      mentions.forEach((mention, index) => {
        socket?.send(JSON.stringify({ jsonrpc: "2.0", id: index + 2, method: "logsSubscribe", params: [{ mentions: [mention] }, { commitment: "confirmed" }] }));
      });
      heartbeat = setInterval(() => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "slotSubscribe" }));
      }, 20_000);
      publish("CONNECTED", `${poolIds.length > 0 ? `合格 Universe ${poolIds.length} 个 Pool` : `Raydium ${RAYDIUM_PROGRAM_IDS.size} 个程序`} · WS endpoint`);
    });
    socket.addEventListener("message", (message) => {
      if (typeof message.data !== "string") return;
      try {
        const payload = JSON.parse(message.data) as {
          id?: number;
          result?: number;
          params?: { subscription?: number; result?: { context?: { slot?: number }; value?: { signature?: string; logs?: string[]; err?: unknown } } };
        };
        if (typeof payload.id === "number" && typeof payload.result === "number") {
          if (payload.id > 1) subscriptions.set(payload.id, String(payload.result));
          return;
        }
        const result = payload.params?.result;
        const slot = result?.context?.slot;
        const value = result?.value;
        if (typeof slot !== "number" || !value || value.err || !Array.isArray(value.logs)) return;
        if (lastSlot !== null && slot > lastSlot + 1) {
          gapCount += 1;
          gapSlots += slot - lastSlot - 1;
        }
        lastSlot = Math.max(lastSlot ?? slot, slot);
        const isRaydiumEvent = value.logs.some((log) => /swap|liquidity|position|initialize/i.test(log));
        if (!isRaydiumEvent) return;
        lastEventAt = new Date().toISOString();
        publish("CONNECTED", `${poolIds.length > 0 ? `合格 Universe ${poolIds.length} 个 Pool` : `Raydium ${RAYDIUM_PROGRAM_IDS.size} 个程序`} · 最近事件 ${lastEventAt}`);
        const event: ChainEvent = { slot, signature: value.signature ?? null, programId: null, logs: value.logs, observedAt: new Date().toISOString(), sourceUrl: url };
        persistIndexerState("stream.last_event", event);
        onEvent(event);
      } catch {
        // 单条损坏消息不影响连接与重连。
      }
    });
    socket.addEventListener("error", () => {
      connected = false;
      publish("RECONNECTING", "WebSocket error，等待退避重连");
      close();
      scheduleReconnect();
    });
    socket.addEventListener("close", () => {
      connected = false;
      publish(stopped ? "STOPPED" : "RECONNECTING", stopped ? "已停止" : "连接关闭，等待重连");
      if (!stopped) scheduleReconnect();
    });
  };

  open();
  return {
    url,
    stop: () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      close();
      publish("STOPPED", "已停止 WebSocket stream");
    },
  };
}

export function startRaydiumTransactionStream(onEvent: (event: ChainEvent) => void, options: { poolIds?: string[] } = {}): IndexerHandle {
  const poolIds = [...new Set(options.poolIds ?? [])];
  const urls = [...new Set(getRpcProviders().map((provider) => provider.wsUrl).filter((url): url is string => Boolean(url)))];
  const generation = ++activeStreamGeneration;
  const connections = urls.map((url) => connectEndpoint(url, onEvent, poolIds, generation));
  const provider = urls.join(",") || "未配置 SOLANA_WS_URLS";
  writeStatus({ status: connections.length > 0 ? "CONNECTING" : "NOT_CONFIGURED", connected: 0, configured: connections.length, lastSlot: null, lastEventAt: null, gapCount: 0, gapSlots: 0, reconnectCount: 0, detail: connections.length > 0 ? `${poolIds.length > 0 ? `合格 Universe ${poolIds.length} 个 Pool` : `Raydium ${RAYDIUM_PROGRAM_IDS.size} 个程序`} · WS Pool ${connections.length} endpoints` : "等待 SOLANA_WS_URLS / RPC Provider" });
  return {
    provider,
    stop: () => connections.forEach((connection) => connection.stop()),
  };
}

// 兼容旧入口；生产 worker 使用 startRaydiumTransactionStream。
export function startRaydiumLogIndexer(onEvent: (event: ChainEvent) => void): IndexerHandle {
  return startRaydiumTransactionStream(onEvent);
}
