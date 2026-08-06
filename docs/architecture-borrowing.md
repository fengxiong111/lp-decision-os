# 架构借鉴记录

## 参考对象

- 项目：[`your-quantguy/gate-crossex`](https://github.com/your-quantguy/gate-crossex)
- 读取日期：2026-08-06
- 许可证：`AGPL-3.0-only`
- 安全分级：`MEDIUM`

参考项目包含远程 bootstrap 脚本、交易所 API 凭据和实盘交易能力。本项目没有执行其安装脚本、没有克隆或运行其代码、没有接入任何交易凭据，也没有复制其业务代码。参考仓库只作为公开文档层面的架构输入。

## 借鉴的设计原则

1. 本地终端优先：服务在用户机器上运行，数据和运行状态留在本地。
2. 启动器产品化：启动前检查运行时、端口和健康状态，失败时给出日志位置。
3. 状态驱动：运行状态、版本、错误和恢复进度进入可查询的状态层，而不是依赖终端输出。
4. 数据安全边界：前端不接触 RPC 密钥或钱包私钥；只读地址与市场数据分离。
5. 可恢复更新：更新前备份本地事实库，迁移使用固定文件名和校验和。
6. 单一事实与派生投影：事实表保存原始事件，市场投影供终端快速读取。

## 本项目的独立实现方式

- `apps/backend` 使用 Fastify 提供 HTTP、WebSocket/SSE 和标准化 API。
- `apps/frontend` 使用 React + Vite，只读取后端投影，不访问 SQLite、Raydium 或 Solana。
- `packages/shared-types` 使用 Zod 做请求、事件和投影边界校验。
- `packages/domain` 使用 `decimal.js` 承担金额、容量和收益计算。
- 现有 `services/storage/event-index.ts` 保留为事实库兼容层，并逐步由 `migrations/` 管理迁移。
- `services/projection/market.ts` 把 REST、WS 和回补结果合并为带单调版本的 `MarketProjection`。
- 现有 Raydium、RPC、回补和钱包实现继续作为内部 adapter；迁移期间通过兼容层保留当前页面、176 个 Pool、游标和已解析 Swap。

## 未复制的代码边界

- 未复制参考项目的源码、组件、交易所适配器、凭据管理实现、安装脚本或其任何 AGPL 实质代码。
- 未复制其 UI、交易逻辑、订单路由、资金划转、对冲机器人或商业链接。
- 本项目的 RWA、Raydium、Solana、LP 容量、排名和切换信号逻辑均为独立实现。

## 许可证检查结果

参考项目 README 明确标注 `GNU AGPL-3.0-only`。本仓库本轮只借鉴思想和公开架构描述，不引入参考仓库文件，不形成代码派生物；如未来需要引入任何源码、补丁或资源，必须先进行单独的许可证审查并重新决定是否可用。

