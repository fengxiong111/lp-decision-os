# Raydium RWA 流动性决策系统

这是一个围绕 Raydium Protocol 的 LP Operating System。前端不直接拼接 REST 请求，而是消费 Connector、发现、链上校验、指标、市场时段、数据质量和决策服务输出的统一快照。后续接入 Orca、Meteora、Jupiter、Phoenix 或 OpenBook 时，只增加 Connector、指标适配器和执行适配器。

## 当前真实数据链路

产品分成两个互不阻塞的模式：

- 公开市场模式：不需要钱包，直接消费 Raydium 官方 RWA / USDC 公开数据，API 可用时始终保留公开 Pool、TVL、24h 成交量、Pool Fee 和 APR。
- 我的仓位模式：`READ_ONLY_SOLANA_ADDRESS` 只是可选配置，仅影响 Position、实际手续费、个性化净收益和迁移建议。

公开市场按数据层级展示：`LEVEL_1_API`（官方 API 数据）、`LEVEL_2_RPC`（API + RPC 账户核验）、`LEVEL_3_REALTIME`（API + RPC + WebSocket + 历史回补）。RPC 429、WebSocket 断开或钱包未配置不会把公开市场清空；只关闭依赖该层的指标并显示降级原因。

公开市场链路：

1. 读取官方 [RWA 流动池页面](https://raydium.io/liquidity-pools/?type=RWA) 使用的 `main/mint-filter-config`，获得 RWA 发现规模。
2. 通过 Raydium v3 `pools/info/list-v2` 的 `mintFilter=RWA` 发现候选池。
3. 公开表格直接保留 `list-v2` 返回的全部真实 RWA/USDC Pool；同一资产的多个 Pool 不互相覆盖，身份由 Base Mint、Quote Mint、Pool Address 和（可选）Position NFT 区分。
4. `pools/key/ids`、CLMM Tick 和 Solana RPC 只作为独立核验层；核验失败的 Pool 标记“待核验”，不从公开表格删除。
5. Raydium API 的 24h 成交量、Pool Fee 和 APR 作为公开市场输入与官方参考；默认唯一排名使用投入后可执行手续费收入，Fee Density 使用 `24h Pool Fee / TVL`，成交活跃度使用 `24h Volume / TVL`。
6. 分钟级事件、WebSocket、历史回补和 CLMM 手续费重算属于更高层级。窗口不完整时保留官方基础数据，并明确显示等待哪一层输入；不会把 API 24h 数据伪装成分钟事件。
7. 配置只读钱包后，系统才读取 `PersonalPositionState`、Position NFT、Tick 范围、Liquidity、Token Fees Owed 和奖励，并按仓位快照计算实际收益。

如果公开 API 本身不可用，页面显示“数据源不可用”；仅仅因为 RPC、WebSocket 或钱包不可用，不会显示 0 个公开 Pool。

## 本地运行

```bash
npm install
./run
```

默认地址是 [http://localhost:3838](http://localhost:3838)。默认只绑定本机；需要局域网访问时显式使用 `LP_ENABLE_LAN=1 ./run`，只允许私有网段。端口冲突会在启动前明确报错，也可以使用 `LP_PORT=3850 ./run`。`./run doctor` 检查 Node、端口、前端构建和 SQLite 完整性；`./run stop` 优雅停止全部进程。

运行时已经拆为 `apps/backend`（Fastify）和 `apps/frontend`（React + Vite）。浏览器只读取 MarketProjection，不直接访问 Raydium、Solana 或 SQLite；关闭浏览器不会停止后台索引和回补。

RPC 池的选择优先级是 `SOLANA_RPC_URLS` / `SOLANA_WS_URLS`，其次是显式配置的 Helius、QuickNode、Alchemy，再其次是 `SOLANA_RPC_FALLBACK_URL`，官方 `https://api.mainnet.solana.com` 仅作最后兜底。当前没有凭据时不会伪称已经切换到付费 RPC；一旦配置新端点，已有 SQLite 游标会继续断点续传，不会从头开始。只读钱包使用 `READ_ONLY_SOLANA_ADDRESS`，只读取公开链上状态，不接受私钥。

官方 RPC 使用保守限速：全局 HTTP 不超过 6 RPS，`getTransaction` 不超过 3 RPS，`getSignaturesForAddress` 不超过 1 RPS，最大并发 6。429 会读取 `Retry-After`，并按 2、4、8、16、32、60 秒退避；429 不会清空 Raydium API 公开市场。Pool/Mint 账户缓存、交易签名缓存和回补 checkpoint 都写入 SQLite；相同签名不会重复请求，回补可以从上次 checkpoint 继续。只在连续 30 分钟 429 比例超过 1%、1h 回补超过 15 分钟、12h 一小时内仍低于 99%、WebSocket 每小时重连超过 3 次、存在无法补齐的 Slot 缺口或官方 RPC 返回 403 时，才建议增加备用/付费 RPC。

### 后台进程与 Supervisor

后端页面进程不会启动或管理后台 worker。Supervisor 管理四个进程，分别负责 API、实时流、统一原始回补和分钟指标派生：

```bash
./run                  # Fastify + Vite + indexer + backfill + metrics
./run stop             # 优雅停止并保留 SQLite 游标
./run doctor           # 运行时与数据库诊断
npm run worker:indexer   # WebSocket + 实时交易去重/回放
npm run worker:backfill  # 一个 raw 12h 任务，按游标断点续传
npm run worker:metrics   # 从 pool_metrics_1m 派生 1m/5m/30m/1h/6h/12h
npm run workers          # 兼容入口；生产推荐使用 ./run
```

回补只维护一个 `rwa-raw-swaps-12h` 任务，短窗口目标固定为 Top20 活跃 RWA/USDC Pool：优先保留 SPCX、SPCXx、NVDAX、DRAM、SPYx、CRCLx、SKHY、TSLAx、SNDK 产品族，再按官方 24h 成交量补足。公开发现仍保留全部 Pool，但非 Top20 不阻塞短窗口排名。1h、6h、12h 只是同一批原始交易与分钟桶的时间切片，必须满足 `1h ≥ 6h ≥ 12h`；单个 Top20 Pool 窗口达到完整即可进入排名，不等待长尾 Pool。24h 保留 Raydium 官方 API 的 `as_of` 结果作为参考，不伪装成逐笔 RPC 回补。每个目标 Pool 都有 SQLite 游标，重启后从 `backfill_pool_cursors` 继续；完整池即使没有交易，也会物化为 0 交易、0 手续费、100% 覆盖的分钟桶。

本地可用这些参数做受控 smoke test；它们不能作为生产完整性证明：

```bash
LP_BACKFILL_SIGNATURE_PAGE_LIMIT=10 \
LP_BACKFILL_MAX_POOLS_PER_CYCLE=1 \
LP_BACKFILL_MAX_SIGNATURE_PAGES_PER_POOL_CYCLE=1 \
npm run worker:backfill
```

`LP_INDEXER_INTERVAL_MS`、`LP_BACKFILL_INTERVAL_MS` 与 `LP_METRICS_INTERVAL_MS` 分别控制三个 worker 的轮询间隔。metrics worker 生成带单调 `projectionVersion` 的 `MarketProjection` 并写入 SQLite；Fastify 首屏只读取投影，API/RPC 暂时失败时保留上次数据并明确显示缓存状态。前端先 GET 快照，再连接 `WS /stream` 接收增量；30 秒 REST 请求只作对账兜底。页面和 `/api/health` 会显示各 worker 生命周期、RPC 分进程统计、合计统计、游标数量、失败记录和窗口覆盖率。

要启动官方 RPC 的 2 小时观测任务（需同时启动三个 worker）：

```bash
LP_INDEXER_RUN_FOR_MS=7200000 npm run worker:indexer
LP_BACKFILL_RUN_FOR_MS=7200000 npm run worker:backfill
LP_METRICS_RUN_FOR_MS=7200000 npm run worker:metrics
```

观测数据写入 `indexer_state`：`rpc.metrics.backfill`、`rpc.metrics.indexer` 和 `rpc.metrics.metrics` 保存分进程请求统计，健康接口合并可加总的请求/方法/429指标；`backfill.raw_swaps_12h` 保存任务与 ETA；`stream.status` 保存 WebSocket 重连与 Slot 缺口。2 小时结束前，状态只能报告为运行中，不能宣称短窗口或可执行净收益排名已经完成。

实时流目前使用 Solana WebSocket `logsSubscribe` 作为通用 fallback，具备多 endpoint、心跳、重连、slot gap 记录和 RPC 回放；Yellowstone/Geyser 未配置时不会被标记为已接入。页面会把这条边界显示在 `REALTIME_STREAM`、覆盖率和健康状态中。

### 状态语义

#### Null Semantics / Zero Exit

全项目只有三种数据状态：真实数值、真实 `0`、未知 `null`。未回补、RPC 没返回、Tick 尚未计算、Fee Growth 尚未对账和净收益输入缺失都必须使用 `null`，不能用 `0`、`undefined`、空字符串、`-`、`—`、`NaN` 或 `Infinity` 代替。API 响应经过统一 Null Semantics 边界清洗；前端通过 `app/components/display-value.tsx` 显示明确原因，例如“等待 1h 回补”“等待 Tick 计算”或“官方 API 未提供”。排名引擎对缺少关键输入的 Pool 直接排除，并把原因放入等待数据集合，不把它们排到最后。

公开市场和短窗口分析是两个门槛。`PUBLIC_MARKET_DATA=READY` 只表示 Raydium 官方公开数据已经可用，不代表链上短窗口、逐笔 LP Fee 或净收益已经完成。只有 1h/6h/12h/24h 回补完整、费用解析和对账通过后，窗口才参与对应排名；当前任何 `BACKFILLING`、`UNAVAILABLE` 或 `FAILED` 都会保留公开基础列，但不给出伪造的综合分数。

当前页面还会分别报告：`PUBLIC_MARKET_STATUS`、`RPC_VERIFICATION_STATUS`、`REALTIME_INDEXING_STATUS`、`WALLET_POSITION_STATUS`、`NET_YIELD_STATUS`。这些状态故意不合并成一个“全部在线”标志。

本阶段目标状态为：

- `PUBLIC_API_MARKET_READY`：官方 Raydium API 公开 RWA 市场可用，无需钱包。
- `SHORT_WINDOW_ANALYTICS_UNAVAILABLE`：1h/6h/12h 真实窗口尚未全部通过覆盖率门槛。
- `NET_YIELD_UNAVAILABLE`：执行成本、IL、再平衡和容量模型尚未全部具备可审计输入。

只有真实 1h、6h、12h 窗口完成，并且投入金额会真实改变 Pool 选择后，才可声明 `EXECUTABLE_RWA_LP_RANKING_READY`。官方 24h APR 仅作为“官方参考”，不是默认建仓排名。

## 目录边界

- `packages/models`：统一 Pool、窗口指标、市场时段、数据质量和推荐模型。
- `packages/connectors`：Raydium Connector 接口边界。
- `packages/engine`：只在净收益、容量、执行成本和质量满足门槛时生成决策。
- `services/raydium`：官方 RWA 发现、Mint 复核、Pool Keys 和 Tick 数据。
- `services/rpc`：多端点 RPC Pool、slot、账户校验、Swap 交易解析和 WebSocket 订阅探针。
- `services/reconciler`：API 与链上状态的对账。
- `services/metrics`：TVL、有效 TVL、交易份额、费率密度、速度和窗口来源。
- `services/session`：纽约时区、夏令时、假日、提前收市和北京时区展示。
- `services/quality`：逐池数据可信度与系统聚合质量。
- `services/indexer`、`services/storage`、`services/alerts`：事件索引、SQLite 实时事件持久化、DuckDB / Parquet 边界和告警边界。
- `apps/backend`：Fastify REST、WebSocket、钱包只读和健康状态。
- `apps/frontend`：React + Vite 终端页面，只消费后端标准化投影。
- `services/projection`：REST/WS/回补合流、版本单调和 last-known-good 投影。
- `migrations`：固定文件名、SHA-256 校验的 SQLite 迁移。

## 验收

```bash
npm run build
npm run build:frontend
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run test:e2e:backend
npm run verify
```

验收页面会检查中文公开市场、真实 API 字段、SPCX/SPCXx 产品族、可选钱包状态、分层状态和旧演示内容不存在；当前 Node 测试包含 121 个单元/服务验收，Playwright E2E 另外覆盖资金切换、排名变化、Pool 展开、解释抽屉、复制和 1920×1080 首屏布局。当前版本只可在事实满足时分别报告 `PUBLIC_API_MARKET_READY`、`SHORT_WINDOW_ANALYTICS_UNAVAILABLE`、`NET_YIELD_UNAVAILABLE`；在短窗口回补、逐笔费用解析、官方对账和净收益模型全部通过前，不声明策略完成或产品上线。
