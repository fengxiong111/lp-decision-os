# LP Alpha Terminal 架构迁移图

## 当前兼容态

```text
Next.js App Router
  ├─ 页面、API、SSE
  ├─ snapshot / ranking 请求路径
  └─ 通过独立 supervisor 运行 indexer / backfill / metrics

SQLite facts
  ├─ normalized_swaps / swap_events_v2
  ├─ pool_metrics_1m / minute_buckets
  ├─ window_coverage / backfill cursors
  └─ indexer_state（含 last_known_good_snapshot）
```

## 目标运行态

```text
Supervisor
  ├─ Fastify backend      → REST + WebSocket + static frontend
  ├─ indexer              → WS / RPC 实时事实
  ├─ backfill             → 有界 12h 回补与断点
  └─ metrics              → 1m 桶、MarketProjection、排名投影

React + Vite frontend
  └─ 只消费 /api/market/snapshot、/api/rankings、/api/health、/stream

SQLite WAL fact store
  └─ MarketProjection（版本化派生快照）
```

## 迁移表

| 现有能力 | 兼容位置 | 目标位置 | 迁移策略 |
| --- | --- | --- | --- |
| Raydium 公开发现 | `services/raydium/api.ts` | `packages/public-data` / `packages/raydium-adapter` | 先保留函数，增加标准化边界 |
| RPC/WS | `services/rpc`, `services/indexer` | `packages/solana-indexer` | 先通过状态投影接入，不重置游标 |
| 事实库 | `services/storage/event-index.ts` | `migrations/` + storage adapter | WAL、锁、checksum 先落地 |
| 24h 与短窗口排名 | `services/rankings` | `packages/decision-engine` | 后端生成 MarketProjection，前端停止排序 |
| 页面 API | `app/api/*` | `apps/backend` | 双栈并行，验证后切换启动入口 |
| 页面 | `app/dashboard-client.tsx` | `apps/frontend` | 复用现有决策表，改为读取投影 |
| worker 监督 | `scripts/workers-supervisor.sh` | `scripts/supervisor.sh` | 增加 PID、退避、健康检查和优雅停止 |

## 不变约束

- 不删除现有 `db/lp-events.sqlite`、`normalized_swaps`、游标、钱包地址和 last-known-good 快照。
- 公开市场不依赖钱包；钱包只读能力仍为可选侧通道。
- 24h 官方数据、$1,000/$10,000 容量计算和 SPCX/SPCXx 比较必须继续可用。

