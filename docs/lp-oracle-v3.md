# LP Oracle V3.0 云端接口

本模块位于 `cloud-oracle/`，与现有 Raydium/SQLite worker 隔离。首选云执行模式是 GitHub Actions Issue Queue：创建标题为 `[LP_ORACLE] 0x...` 的 issue，workflow 会调用本模块并自动评论结果。

现有 HTTP endpoint 仍保留，便于兼容和调试，但不是首选生产入口：

`GET /api/analyze?address=0x...`

响应的 `schemaVersion` 固定为 `lp-oracle-v3.0`，包含 `sources`、`authority`、`candidates` 和 `decision`。未知值使用 `null`；原因使用 `blockedReasons`，不会用 0 伪造缺失数据。

数据优先级是可配置的 OKX/Uniswap/RPC 适配器，公开 GeckoTerminal，再由 DexScreener 作为实际无密钥可运行 fallback。当前无密钥时，OKX、Uniswap、RPC 会明确返回 `BLOCKED_AUTH`，而公开 fallback 仍可工作。

候选区间暂为价格中心的 Core ±12% 与 Buffer ±30%，回放使用公开 h1/h6/h24 成交量代理。它不是完成 Tick crossing、IL、容量、Gas 或执行仿真后的可执行建仓指令；不足时 action 只会是 `WAIT`/`HOLD`，不会输出 `ENTER`。

## 环境变量

- `OKX_API_KEY`：启用 OKX 配置状态（具体 endpoint 需按账户 API 合约接入）。
- `UNISWAP_API_KEY`：启用 Uniswap 配置状态（具体 endpoint 需按账户 API 合约接入）。
- `EVM_RPC_URL`：启用 RPC 配置状态。

密钥不应提交到仓库；Vercel 环境变量只保存运行时凭据。

## Issue Queue 使用方式

1. 在仓库创建标题严格为 `[LP_ORACLE] <EVM 地址>` 的 issue。
2. `.github/workflows/lp-oracle-issue.yml` 在 `opened` 或带 `lp-oracle` 标签时运行。
3. workflow 使用仓库内 `GITHUB_TOKEN` 读取公开 API，并在 issue 评论 JSON 结果；不需要第三方账号、常驻机器或自建服务。
4. 评论中的 `7d`、selected pool 等没有证据的值保持 `null`，原因保存在 `blocked`。
