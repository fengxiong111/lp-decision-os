# DEPRECATED: LP Oracle V3 in this repository

LP Oracle 已迁移到独立稳定能力仓库：<https://github.com/fengxiong111/lp-range-oracle>。

本 Raydium RWA 仓库继续负责 Solana/Raydium 看板、前后端、worker 与 SQLite；不要在这里新增 LP Oracle Issue。旧的 `LP Oracle Bootstrap Queue` 已停用，保留 feature branch / PR #1 原样，不合并、不删除，作为迁移审计记录。

新的使用闭环是：ChatGPT 发地址 → 在 `lp-range-oracle` 创建 `[LP_ORACLE] <EVM 地址>` Issue → GitHub Actions → `[LP_ORACLE_RESULT]` artifact → ChatGPT 读取并给出 Core / Buffer / Action。
