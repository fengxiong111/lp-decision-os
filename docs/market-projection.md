# MarketProjection

## 快照结构

```ts
type MarketProjection = {
  projectionVersion: number;
  source: "market-projection";
  sourceTimestamp: string;
  receivedAt: string;
  updatedAt: string;
  snapshot: DashboardSnapshot;
  rankings: {
    "1000": { "1h": RankingResponse; "6h": RankingResponse; "12h": RankingResponse; "24h": RankingResponse };
    "10000": { "1h": RankingResponse; "6h": RankingResponse; "12h": RankingResponse; "24h": RankingResponse };
  };
  sourceHealth: {
    publicMarket: PublicMarketHealth;
    rpc: RpcPoolSnapshot;
    websocket: ServiceHealth;
    swapIndexer: EventIndexSnapshot;
  };
};
```

`sourceTimestamp` 用官方 API 的 `apiObservedAt`，`receivedAt` 是本机接收时间，`updatedAt` 是投影生成时间。每次投影写入 SQLite `market_projection_snapshots`，版本单调递增；接口不会在浏览器请求路径触发 Raydium 或 RPC。

## 更新合流规则

1. metrics worker 读取 Raydium REST、标准化 Swap、1 分钟桶和 worker 状态。
2. REST 成功后生成新的 projection；旧 `sourceTimestamp` 不得覆盖较新的投影。
3. WebSocket 事件先进入事实表，再由 metrics worker 派生下一个投影，避免浏览器直接解释链上原始日志。
4. 页面首次 GET `/api/market/snapshot`，随后连接 `/stream`；事件版本小于等于本地版本时丢弃。
5. 断线后重新 GET 快照；30 秒 REST ranking 请求只作为对账兜底。

## WebSocket 事件

| 事件 | 载荷 | 用途 |
| --- | --- | --- |
| `market.snapshot` | 完整 `MarketProjection` | 首次连接、断线恢复 |
| `pool.updated` | Pool 标准化变更 | 局部池更新 |
| `metric.updated` | 窗口指标 | 1m 桶派生 |
| `ranking.updated` | 单一投入金额/窗口排名 | 前端刷新答案 |
| `backfill.updated` | 游标和覆盖率 | 显示回补状态 |
| `health.updated` | 来源和进程健康 | 显示降级原因 |
| `switch.signal` | 切换状态机事件 | 触发一次性迁移提示 |
| `wallet.updated` | 只读仓位变更 | 可选个性化区域 |

当前生产通道先发送 `market.snapshot`；其余事件类型已在共享 Schema 中固定，随着 worker 事件投影接线逐步启用。

