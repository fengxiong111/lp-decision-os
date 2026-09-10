# LP Oracle V3.0 云端接口

本模块位于 `cloud-oracle/`，与现有 Raydium/SQLite worker 隔离。Vercel 通过 Next.js Route Handler 提供：

`GET /api/analyze?address=0x...`

响应的 `schemaVersion` 固定为 `lp-oracle-v3.0`，包含 `sources`、`authority`、`candidates` 和 `decision`。未知值使用 `null`；原因使用 `blockedReasons`，不会用 0 伪造缺失数据。

数据优先级是可配置的 OKX/Uniswap/RPC 适配器，公开 GeckoTerminal，再由 DexScreener 作为实际无密钥可运行 fallback。当前无密钥时，OKX、Uniswap、RPC 会明确返回 `BLOCKED_AUTH`，而公开 fallback 仍可工作。

候选区间暂为价格中心的 Core ±12% 与 Buffer ±30%，回放使用公开 h1/h6/h24 成交量代理。它不是完成 Tick crossing、IL、容量、Gas 或执行仿真后的可执行建仓指令；不足时 action 只会是 `WAIT`/`HOLD`，不会输出 `ENTER`。

## 环境变量

- `OKX_API_KEY`：启用 OKX 配置状态（具体 endpoint 需按账户 API 合约接入）。
- `UNISWAP_API_KEY`：启用 Uniswap 配置状态（具体 endpoint 需按账户 API 合约接入）。
- `EVM_RPC_URL`：启用 RPC 配置状态。

密钥不应提交到仓库；Vercel 环境变量只保存运行时凭据。
