"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CAPITAL_OPTIONS, type DashboardSnapshot } from "@/packages/models/src";
import type { RankingMetric, RankingPair, RankingPool, RankingResponse, RankingWindowStatus } from "@/services/rankings";
import { DisplayValue } from "@/app/components/display-value";
import { coverageIsDeterministicallyComplete } from "@/services/indexer/progress";

type TerminalCapital = (typeof CAPITAL_OPTIONS)[number];
type TerminalWindow = "1h" | "6h" | "12h" | "24h";
type Decision = RankingPair["decision"];

const WINDOWS: Array<{ key: TerminalWindow; label: string }> = [
  { key: "24h", label: "24小时" },
  { key: "1h", label: "1小时" },
  { key: "6h", label: "6小时" },
  { key: "12h", label: "12小时" },
];

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function money(value: number | null | undefined, digits = 2, missing = "暂无数据") {
  return finite(value) ? `$${new Intl.NumberFormat("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value)}` : missing;
}

function stockPrice(value: number | null | undefined, missing = "价格暂无") {
  if (!finite(value)) return missing;
  return money(value, Math.abs(value) < 10 ? 4 : 2, missing);
}

function priceBand(low: number | null, high: number | null) {
  if (low === null && high === null) return <span className="metric-unavailable">24h区间暂无</span>;
  return <><strong>低 {stockPrice(low)}</strong><small>高 {stockPrice(high)}</small></>;
}

function number(value: number | null | undefined, digits = 0, missing = "暂无数据") {
  return finite(value) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value) : missing;
}

function percent(value: number | null | undefined, digits = 1, missing = "暂无数据") {
  return finite(value) ? `${value.toFixed(digits)}%` : missing;
}

function rangeText(value: RankingPool["rangePct"]) {
  return value ? `${value.lower >= 0 ? "+" : ""}${value.lower.toFixed(2)}% ～ ${value.upper >= 0 ? "+" : ""}${value.upper.toFixed(2)}%` : "区间暂无";
}

function shortAddress(value: string | null | undefined) {
  if (!value) return "Pool地址暂无";
  return `${value.slice(0, 6)}…${value.slice(-6)}`;
}

function clock(value: string | null | undefined) {
  if (!value) return "暂无时间";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value));
}

function decisionLabel(value: Decision) {
  return value === "RECOMMEND" ? "推荐" : value === "WATCH" ? "观察" : value === "REJECT" ? "放弃" : "短窗口回补中";
}

function decisionClass(value: Decision) {
  return value === "RECOMMEND" ? "verdict-good" : value === "REJECT" ? "verdict-bad" : value === "WATCH" ? "verdict-neutral" : "verdict-muted";
}

function snapshotWindowStatus(snapshot: DashboardSnapshot, key: TerminalWindow): RankingWindowStatus {
  if (key === "24h") {
    const available = snapshot.pools.some((pool) => pool.fee24h !== null || pool.volume24h !== null);
    const activePoolCount = snapshot.universe?.activePoolCount ?? snapshot.pools.length;
    const activeKnown = snapshot.pools.filter((pool) => pool.universeStatus === "ACTIVE_INDEXED" && (pool.fee24h !== null || pool.volume24h !== null)).length;
    return { key, label: "24小时", status: available ? "COMPLETE" : "UNAVAILABLE", state: available ? "官方API" : "不可用", enabled: available, progress: activePoolCount > 0 ? Math.round(activeKnown / activePoolCount * 100) : null, coverage: activePoolCount > 0 ? activeKnown / activePoolCount : null, completedPools: activeKnown, targetPools: activePoolCount, universeLabel: available ? `官方 API · 公开 ${snapshot.pools.length} 个 Pool；合格 ${activeKnown}/${activePoolCount}` : "官方 API 数据不可用", updatedAt: snapshot.generatedAt, source: "Raydium 官方 API v3 · 24h as_of", reason: available ? null : "官方24h数据不可用" };
  }
  const coverage = snapshot.swapIndexer.windows[key];
  const raw = coverage.timeCoverageRatio ?? coverage.coverageRatio ?? coverage.completeness;
  const ratio = finite(raw) ? Math.max(0, Math.min(1, raw > 1 ? raw / 100 : raw)) : null;
  const status: RankingWindowStatus["status"] = coverageIsDeterministicallyComplete(coverage, key)
    ? "COMPLETE"
    : coverage.backfillStatus === "RUNNING" || coverage.backfillStatus === "BACKFILLING" ? "BACKFILLING"
      : ratio !== null || coverage.eventCount > 0 ? "PARTIAL" : "UNAVAILABLE";
  const completedPools = coverage.completedPoolCount ?? null;
  const targetPools = coverage.targetPoolCount ?? snapshot.universe?.activePoolCount ?? snapshot.pools.length;
  const universeLabel = completedPools !== null && targetPools !== null
    ? completedPools >= targetPools && targetPools > 0 ? `覆盖全部 ${targetPools} 个 Pool` : `覆盖 ${completedPools}/${targetPools} 个 Pool`
    : "活跃 Pool 分批回补中";
  const reason = status === "COMPLETE"
    ? null
    : coverage.progressReason ?? (completedPools !== null ? `尚未完成历史覆盖，当前 ${completedPools}/${targetPools} 个 Pool` : "尚未完成历史覆盖");
  return { key, label: WINDOWS.find((item) => item.key === key)?.label ?? key, status, state: status === "COMPLETE" ? "完整" : status === "PARTIAL" ? "部分完整" : status === "BACKFILLING" ? "回补中" : "不可用", enabled: status !== "UNAVAILABLE", progress: ratio === null ? null : Math.round(ratio * 100), coverage: ratio, completedPools, targetPools, universeLabel, updatedAt: coverage.lastEventTime ?? snapshot.generatedAt, source: "Solana RPC 交易回补", reason };
}

async function copyText(value: string, onDone: () => void) {
  try {
    await navigator.clipboard.writeText(value);
    onDone();
  } catch {
    const input = document.createElement("textarea");
    input.value = value;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
    onDone();
  }
}

function CopyButton({ value, label, testId, onCopied }: { value: string | null | undefined; label: string; testId?: string; onCopied?: (label: string) => void }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return <button className="copy-button" data-testid={testId} title={value} onClick={(event) => { event.stopPropagation(); void copyText(value, () => { setCopied(true); onCopied?.(label); window.setTimeout(() => setCopied(false), 1400); }); }}>{copied ? "已复制" : label}</button>;
}

function StatusDot({ state }: { state: "good" | "warn" | "muted" }) {
  return <i className={`terminal-dot ${state}`} aria-hidden="true" />;
}

function WindowButton({ view, active, onClick }: { view: RankingWindowStatus; active: boolean; onClick: () => void }) {
  const suffix = view.key === "24h" && view.status === "COMPLETE"
    ? " API"
    : view.completedPools !== null && view.targetPools !== null
      ? ` 完成${view.completedPools}/${view.targetPools}`
      : view.progress !== null ? ` ${view.progress}%` : "";
  const disabled = view.status === "UNAVAILABLE";
  return <button className={`terminal-window ${active ? "active" : ""} ${disabled ? "disabled" : ""}`} disabled={disabled} onClick={onClick} title={disabled ? `${view.label}：等待数据源` : `${view.label}：${view.state} · ${view.universeLabel}${view.progress !== null ? ` · 时间覆盖 ${view.progress}%` : ""}`} data-testid={`window-${view.key}`}>{view.label}{suffix}</button>;
}

function StatusBar({ snapshot, lastSuccessfulRefresh, onSystem, onWallet }: { snapshot: DashboardSnapshot; lastSuccessfulRefresh: string | null; onSystem: () => void; onWallet: () => void }) {
  return <div className="terminal-statusbar">
    <span><StatusDot state={snapshot.snapshotSource === "LAST_KNOWN_GOOD" ? "warn" : "good"} />公开市场：{snapshot.snapshotSource === "LAST_KNOWN_GOOD" ? "缓存" : "正常"}</span>
    <span><StatusDot state={snapshot.websocket.status === "在线" ? "good" : "warn"} />实时索引：{snapshot.websocket.status === "在线" ? "运行中" : "降级"}</span>
    <span>最近 Swap：{clock(snapshot.lastSwap?.blockTime)}</span>
    <span>最近成功更新：{clock(lastSuccessfulRefresh)}</span>
    <span className="auto-refresh-status">REST兜底：15秒 · WS实时</span>
    {snapshot.snapshotSource === "LAST_KNOWN_GOOD" ? <span className="cache-notice">更新失败，继续显示上次成功数据</span> : null}
    <button className="system-button" onClick={onWallet} aria-label={snapshot.wallet.configured ? "修改或添加只读钱包" : undefined} data-testid="wallet-control">{snapshot.wallet.configured ? `我的仓位 ${snapshot.positions.length}` : "添加只读钱包"}</button>
    <button className="system-button" onClick={onSystem}>系统详情</button>
  </div>;
}

function MetricCell({ metric, coverage, empty = "等待模型输入" }: { metric: RankingMetric; coverage: RankingWindowStatus; empty?: string }) {
  const detail = metric.missing[0] ?? (coverage.key === "24h" ? empty : "回补中");
  return <DisplayValue value={metric.value} missing={detail} format={(value) => money(value as number)} className={metric.value === null ? "metric-unavailable" : "metric-ready"} />;
}

function PoolLinks({ pool, onCopied }: { pool: RankingPool; onCopied: (label: string) => void }) {
  return <div className="pool-links"><CopyButton value={pool.poolAddress} label="复制 Pool" testId={`copy-pool-${pool.poolAddress}`} onCopied={onCopied} /><CopyButton value={pool.baseMint} label="复制 Mint" testId={`copy-base-${pool.poolAddress}`} onCopied={onCopied} /><CopyButton value={pool.programId} label="复制 Program" testId={`copy-program-${pool.poolAddress}`} onCopied={onCopied} /><a href={`https://solscan.io/account/${pool.poolAddress}`} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>Solscan</a><a href={`https://raydium.io/liquidity/?pool=${pool.poolAddress}`} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>Raydium</a></div>;
}

function PoolSubtable({ pair, positionPoolIds, onCopied, showNet }: { pair: RankingPair; positionPoolIds: Set<string>; onCopied: (label: string) => void; showNet: boolean }) {
  return <div className="pool-subtable" data-testid={`pool-details-${pair.pairId}`}>
    <div className="subtable-heading"><div><strong>{pair.symbol}</strong><span>全部 {pair.allPools.length} 个独立 Pool · 以投入 {pair.capacity.capital.toLocaleString("en-US")}U 的可执行手续费收入排序</span></div><span className={`verdict ${decisionClass(pair.decision)}`}>{decisionLabel(pair.decision)}</span></div>
    <div className="subtable-scroll"><table><thead><tr><th>Pool / Mint / Program</th><th>研究状态</th><th>类型</th><th>Fee Tier</th><th>Tick spacing / 当前 Tick</th><th>范围</th><th>TVL / 有效TVL</th><th>窗口成交量</th><th>窗口LP Fee</th><th>Route Share</th><th>容量拆解</th><th>预计手续费</th>{showNet ? <th>预计净利润</th> : null}<th>结论</th></tr></thead><tbody>{pair.allPools.map((pool) => <tr key={pool.poolAddress} className={pool.selected ? "selected" : ""}>
      <td><div className="sub-address"><code title={pool.poolAddress}>{shortAddress(pool.poolAddress)}</code>{positionPoolIds.has(pool.poolAddress) ? <span className="position-tag">我的仓位</span> : null}</div><PoolLinks pool={pool} onCopied={onCopied} /></td>
      <td><strong>{pool.universeStatus === "ACTIVE_INDEXED" ? "合格 · 已索引" : pool.universeStatus === "OFFICIAL_ONLY" ? "官方数据" : "已隔离"}</strong><small>{pool.universeReason}</small></td><td>{pool.poolType}</td><td className="numeric">{pool.feeTier ?? "Fee Tier暂无"}</td><td className="numeric">{number(pool.tickSpacing, 0, "Tick spacing暂无")} / {number(pool.currentTick, 0, "当前 Tick暂无")}</td><td><span title={pool.fullTicks ? `Tick ${pool.fullTicks.lower}–${pool.fullTicks.upper}` : "区间暂无"}>{rangeText(pool.rangePct)}</span><small>{pool.fullTicks ? `Tick ${pool.fullTicks.lower}–${pool.fullTicks.upper}` : "Tick暂无"}</small></td>
      <td className="numeric">{money(pool.tvl, 0, "TVL暂无")} / {money(pool.effectiveTvl, 0, "有效TVL暂无")}</td><td className="numeric">{money(pool.volume, 0, pool.coverage.key === "24h" ? "成交量暂无" : "回补中")}</td><td className="numeric">{money(pool.lpFee, 2, pool.coverage.key === "24h" ? "LP Fee暂无" : "回补中")}</td><td className="numeric">{pool.poolRouteShare === null ? "Route Share暂无" : `承接 ${pool.poolRouteShare.toFixed(2)}%`}</td>
      <td><strong>{pool.capacity.status === "等待数据" ? "容量暂无" : pool.capacity.status}</strong><small>{pool.capacity.message}</small><small>投入后TVL {money(pool.capacity.postDepositTvl, 0, "暂无")} · 份额 {percent(pool.capacity.capitalShare === null ? null : pool.capacity.capitalShare * 100, 1, "暂无")}</small></td>
      <td className="numeric"><MetricCell metric={pool.estimatedFeeIncome} coverage={pool.coverage} empty="未计算" /></td>{showNet ? <td className="numeric"><MetricCell metric={pool.estimatedNetProfit} coverage={pool.coverage} empty="未计算" /></td> : null}
      <td><span className={`verdict ${decisionClass(pool.decision)}`}>{decisionLabel(pool.decision)}</span><small className="sub-reason">{pool.shortReason}</small></td>
    </tr>)}</tbody></table></div>
  </div>;
}

function RankingRow({ pair, rank, expanded, onToggle, onEvidence, positionPoolIds, onCopied, showNet }: { pair: RankingPair; rank: number; expanded: boolean; onToggle: () => void; onEvidence: () => void; positionPoolIds: Set<string>; onCopied: (label: string) => void; showNet: boolean }) {
  const pool = pair.recommendedPool ?? pair.allPools[0] ?? null;
  const isRanked = rank > 0 && pool?.universeStatus === "ACTIVE_INDEXED" && (pair.estimatedFeeIncome.value !== null || Boolean(pool.lpFee24h !== null && pool.tvl !== null && pool.tvl > 0));
  const rowId = pair.symbol.replace(/[^a-zA-Z0-9]+/g, "-");
  return <>
    <tr className={`ranking-row ${expanded ? "expanded" : ""}`} onClick={onToggle} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onToggle(); } }} data-testid={`pair-row-${rowId}`}>
      <td className="rank numeric">{isRanked ? String(rank).padStart(2, "0") : "—"}</td>
      <td><strong>{pair.symbol}</strong><small>{pair.underlying} · {pair.allPools.length} 个 Pool</small></td>
      <td>{pool ? <><strong>{pool.feeTier ?? "Fee Tier暂无"}</strong><small title={pool.poolAddress}>{shortAddress(pool.poolAddress)} <CopyButton value={pool.poolAddress} label="复制" testId={`main-copy-pool-${pool.poolAddress}`} onCopied={onCopied} /></small>{positionPoolIds.has(pool.poolAddress) ? <span className="position-icon" title="我的仓位" aria-label="我的仓位">●</span> : null}</> : <span>Pool地址暂无</span>}</td>
      <td className="numeric">{stockPrice(pair.currentPrice ?? pool?.currentPrice ?? null)}</td><td className="numeric price-band-cell">{priceBand(pair.price24hLow ?? pool?.price24hLow ?? null, pair.price24hHigh ?? pool?.price24hHigh ?? null)}</td>
      <td className="numeric">{money(pair.tvl ?? pool?.tvl ?? null, 0, "TVL暂无")}</td><td className="numeric">{money(pair.volume ?? pool?.volume ?? null, 0, pair.coverage.key === "24h" ? "成交量暂无" : "回补中")}</td><td className="numeric">{money(pair.lpFee ?? pool?.lpFee ?? null, 2, pair.coverage.key === "24h" ? "LP Fee暂无" : "回补中")}</td>
      <td className="numeric"><MetricCell metric={pair.estimatedFeeIncome} coverage={pair.coverage} empty="未计算" /></td>
      <td><button className={`verdict ${decisionClass(pair.decision)}`} onClick={(event) => { event.stopPropagation(); onEvidence(); }} data-testid={`decision-${rowId}`}>{decisionLabel(pair.decision)}</button><small className="row-reason" title={pair.shortReason}>{Array.from(pair.shortReason).slice(0, 18).join("")}</small></td>
    </tr>
    {expanded ? <tr className="expanded-row"><td colSpan={10}><PoolSubtable pair={pair} positionPoolIds={positionPoolIds} onCopied={onCopied} showNet={showNet} /></td></tr> : null}
  </>;
}

function EvidenceDrawer({ pair, onClose }: { pair: RankingPair; onClose: () => void }) {
  const pool = pair.recommendedPool;
  const fee = pair.estimatedFeeIncome;
  const net = pair.estimatedNetProfit;
  return <div className="drawer-backdrop" onClick={onClose}><aside className="evidence-drawer" onClick={(event) => event.stopPropagation()}><div className="drawer-title"><div><small>唯一排名 · {pair.capacity.capital.toLocaleString("en-US")}U · {pair.coverage.label}</small><h2>{pair.symbol}</h2></div><button className="close-button" onClick={onClose} aria-label="关闭排名依据">×</button></div>
    <div className={`drawer-verdict ${decisionClass(pair.decision)}`}><strong>{decisionLabel(pair.decision)}</strong><span>{pair.shortReason}</span></div>
    <dl className="evidence-list"><div><dt>推荐 Pool</dt><dd>{pool ? shortAddress(pool.poolAddress) : "Pool地址暂无"}</dd></div><div><dt>Fee Tier</dt><dd>{pool?.feeTier ?? "Fee Tier暂无"}</dd></div><div><dt>股票价格</dt><dd>{stockPrice(pair.currentPrice ?? pool?.currentPrice ?? null)}</dd></div><div><dt>24小时上下限</dt><dd>{pool ? priceBand(pool.price24hLow, pool.price24hHigh) : "24h区间暂无"}</dd></div><div><dt>建议区间</dt><dd>{rangeText(pair.recommendedRangePct)}</dd></div><div><dt>预计手续费收入</dt><dd>{fee.value === null ? fee.missing[0] ?? "未计算" : money(fee.value)}</dd></div><div><dt>预计净利润</dt><dd>{net.value === null ? net.missing[0] ?? "未计算" : money(net.value)}</dd></div><div><dt>容量</dt><dd>{pool?.capacity.status ?? "容量暂无"}</dd></div><div><dt>窗口覆盖</dt><dd>{pair.coverage.state}{pair.coverage.progress !== null ? ` · ${pair.coverage.progress}%` : " · 覆盖率暂无"}</dd></div></dl>
    <h3>正向贡献</h3><div className="explain-factors"><div><span>Route Share</span><strong>{pool?.poolRouteShare === null || pool?.poolRouteShare === undefined ? "Route Share暂无" : `${pool.poolRouteShare.toFixed(2)}%`}</strong><small>权重 35% · 承接该底层资产的真实成交</small></div><div><span>投入后容量</span><strong>{pool?.capacity.status ?? "容量暂无"}</strong><small>权重 30% · {pool?.capacity.message ?? "有效TVL暂无"}</small></div><div><span>可执行手续费</span><strong>{fee.value === null ? fee.missing[0] ?? "未计算" : money(fee.value)}</strong><small>权重 35% · {fee.formula}</small></div></div>
    <h3>负向扣分</h3><ul>{pool?.capacity.status !== "充足" ? <li>{pool?.capacity.message}</li> : null}{fee.missing.map((item) => <li key={item}>{item}</li>)}{net.missing.map((item) => <li key={item}>{item}</li>)}</ul>
    <div className="drawer-note">公式：{fee.formula}<br />净利润公式：{net.formula}<br />原始数据来自窗口 LP Fee、TVL、Tick/区间概率与投入金额；官方 APR 不参与默认推荐。</div><footer>模型版本：lp-decision-ranking-v4 · 只读公开市场模式</footer>
  </aside></div>;
}

function WalletModal({ snapshot, onClose, onUpdated }: { snapshot: DashboardSnapshot; onClose: () => void; onUpdated: (snapshot: DashboardSnapshot) => void }) {
  const [address, setAddress] = useState(snapshot.wallet.address ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function save() {
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/wallet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address }) });
      const payload = await response.json() as { error?: string; wallet?: { scanning?: boolean }; snapshot?: DashboardSnapshot };
      if (!response.ok || !payload.snapshot) { setError(payload.error ?? "保存失败"); return; }
      onUpdated(payload.snapshot);
      if (payload.wallet?.scanning) setMessage("已保存，仓位扫描已在后台开始；稍后可点击重新扫描"); else { setMessage(`已保存，发现 ${payload.snapshot.positions.length} 个仓位`); onClose(); }
    } catch { setError("钱包服务数据源不可用，请稍后重试"); } finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true); setError("");
    try { const response = await fetch("/api/wallet", { method: "DELETE" }); const payload = await response.json() as { snapshot?: DashboardSnapshot }; if (payload.snapshot) { onUpdated(payload.snapshot); onClose(); } } catch { setError("钱包状态更新失败，请稍后重试"); } finally { setBusy(false); }
  }
  async function rescan() {
    setBusy(true); setError("");
    try { const response = await fetch("/api/wallet/rescan", { method: "POST" }); const payload = await response.json() as { error?: string; snapshot?: DashboardSnapshot }; if (!response.ok || !payload.snapshot) { setError(payload.error ?? "扫描失败"); return; } onUpdated(payload.snapshot); setMessage(`扫描完成，发现 ${payload.snapshot.positions.length} 个仓位`); } catch { setError("仓位扫描数据源不可用，请稍后重试"); } finally { setBusy(false); }
  }
  return <div className="modal-backdrop" onClick={onClose}><div className="wallet-modal" onClick={(event) => event.stopPropagation()}><div className="modal-title"><div><small>我的仓位（可选）</small><h2>{snapshot.wallet.configured ? "修改只读钱包" : "添加只读钱包"}</h2></div><button className="close-button" onClick={onClose} aria-label="关闭钱包弹窗">×</button></div><label htmlFor="wallet-address">公开 Solana 地址</label><input id="wallet-address" value={address} onChange={(event) => setAddress(event.target.value)} placeholder="输入 Base58 公钥地址" autoComplete="off" spellCheck={false} /><p className="wallet-safe-note">只读取公开链上仓位，不请求签名。不接受私钥或助记词。</p>{error ? <p className="form-error">{error}</p> : null}{message ? <p className="form-success">{message}</p> : null}<div className="modal-actions"><button className="primary-button" onClick={() => void save()} disabled={busy}>{busy ? "处理中…" : "保存并扫描"}</button><button className="secondary-button" onClick={onClose} disabled={busy}>取消</button>{snapshot.wallet.configured ? <><button className="secondary-button" onClick={() => void rescan()} disabled={busy}>重新扫描</button><button className="danger-button" onClick={() => void remove()} disabled={busy}>移除地址</button></> : null}</div></div></div>;
}

function SystemDrawer({ snapshot, onClose }: { snapshot: DashboardSnapshot; onClose: () => void }) {
  const access = snapshot.localAccess;
  const statusText = (key: string, value: string) => {
    const map: Record<string, string> = {
      PUBLIC_MARKET_STATUS: "公开市场",
      SHORT_WINDOW_ANALYTICS_STATUS: "短窗口分析",
      RPC_VERIFICATION_STATUS: "链上账户核验",
      REALTIME_INDEXING_STATUS: "实时索引",
      WALLET_POSITION_STATUS: "我的仓位",
      NET_YIELD_STATUS: "净收益模型",
    };
    const values: Record<string, string> = {
      PUBLIC_API_MARKET_READY: "已就绪",
      SHORT_WINDOW_ANALYTICS_UNAVAILABLE: "正在补齐历史",
      SHORT_WINDOW_ANALYTICS_READY: "已就绪",
      RPC_VERIFICATION_UNAVAILABLE: "等待 RPC 核验",
      RPC_VERIFICATION_DEGRADED: "部分核验",
      RPC_VERIFICATION_PARTIAL: "部分核验",
      REALTIME_INDEXING_AVAILABLE: "运行中",
      REALTIME_INDEXING_DEGRADED: "降级运行",
      WALLET_POSITION_OPTIONAL_CONFIGURED: "已配置（可选）",
      WALLET_POSITION_OPTIONAL_NOT_CONFIGURED: "未配置（不影响公开市场）",
      NET_YIELD_UNAVAILABLE: "尚未接入 IL 与滑点成本",
      NET_YIELD_AVAILABLE: "已就绪",
    };
    if (key === "SHORT_WINDOW_ANALYTICS_STATUS" && value.includes("完成")) return `短窗口：${value}`;
    return `${map[key] ?? key}：${values[value] ?? value}`;
  };
  return <div className="drawer-backdrop" onClick={onClose}><aside className="evidence-drawer system-drawer" onClick={(event) => event.stopPropagation()}><div className="drawer-title"><div><small>连接与数据状态</small><h2>系统详情</h2></div><button className="close-button" onClick={onClose} aria-label="关闭系统详情">×</button></div><div className="system-list">{Object.entries(snapshot.statusReport).map(([key, value]) => <div key={key}><span>{statusText(key, value)}</span></div>)}</div>{access ? <div className="lan-access"><strong>局域网访问地址</strong><div><code>{access.lanUrl ?? "未检测到局域网地址"}</code><CopyButton value={access.lanUrl} label="复制地址" onCopied={() => undefined} /></div>{access.lanUrl ? <img className="lan-qr" src={`https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(access.lanUrl)}`} alt="局域网访问二维码" /> : null}<small>本机：{access.localUrl} · 需与 iPad 连接同一 Wi‑Fi。当前仅验证服务监听地址，真实 iPad 验收仍需现场设备完成。</small></div> : null}<div className="drawer-note">公开市场无需钱包；RPC、WebSocket或短窗口回补异常只会关闭依赖项，不会清空官方 API 市场数据。</div></aside></div>;
}

function ProgressDrawer({ snapshot, view, onClose }: { snapshot: DashboardSnapshot; view: TerminalWindow; onClose: () => void }) {
  const coverage = snapshot.swapIndexer.windows[view];
  const progress = coverage.timeCoverageRatio ?? coverage.coverageRatio ?? coverage.completeness;
  const progressPercent = finite(progress) ? (progress > 1 ? progress : progress * 100) : null;
  const completePools = coverage.completedPoolCount ?? null;
  const targetPools = coverage.targetPoolCount ?? snapshot.discovery.candidatePoolCount;
  const oldestCovered = coverage.oldestCoveredAt ?? coverage.oldestCoveredBlockTime ?? null;
  return <div className="drawer-backdrop" onClick={onClose}><aside className="evidence-drawer progress-drawer" onClick={(event) => event.stopPropagation()}><div className="drawer-title"><div><small>窗口证据 · {WINDOWS.find((item) => item.key === view)?.label ?? view}</small><h2>{coverage.backfillStatus === "COMPLETE" || coverage.backfillStatus === "LIVE" ? "完整" : "回补进度"}</h2></div><button className="close-button" onClick={onClose} aria-label="关闭窗口进度">×</button></div><div className="progress-summary"><strong>{progressPercent === null ? "等待覆盖数据" : `${progressPercent.toFixed(1)}%`}</strong><span>{completePools === null ? "等待 Pool 进度" : `${completePools} / ${targetPools} 个 Pool 已到窗口边界`}</span></div><dl className="evidence-list"><div><dt>窗口范围</dt><dd>{coverage.windowStart ? `${clock(coverage.windowStart)} → ${clock(coverage.windowEnd)}` : "等待窗口边界"}</dd></div><div><dt>最老已覆盖</dt><dd>{oldestCovered ? clock(oldestCovered) : "等待回补"}</dd></div><div><dt>签名 / 交易</dt><dd>{number(coverage.signaturesDiscovered)} / {number(coverage.transactionsFetched)}</dd></div><div><dt>解析 Swap</dt><dd>{number(coverage.swapsParsed)} · 失败 {number(coverage.transactionsFailed)}</dd></div><div><dt>未识别指令</dt><dd>{number(coverage.unknownInstructions)} · Gap Slot {number(coverage.gapSlots)}</dd></div><div><dt>最近5分钟</dt><dd>{number(coverage.requestsLast5m)} 请求 · {number(coverage.successfulTransactionsLast5m)} 笔成功</dd></div><div><dt>当前吞吐</dt><dd>{coverage.transactionsPerMinute === null || coverage.transactionsPerMinute === undefined ? "等待吞吐数据" : `${coverage.transactionsPerMinute.toFixed(1)} 笔/分钟`} · 最近5分钟推进 {number(coverage.completedPoolsLast5m)}</dd></div><div><dt>ETA</dt><dd>{coverage.etaAt ? clock(coverage.etaAt) : "等待回补速度"}</dd></div></dl>{coverage.progressReason ? <div className="ranking-error">已暂停：{coverage.progressReason}</div> : null}<div className="drawer-note">窗口进度来自同一个 raw 12h 回补和 `pool_metrics_1m` 分钟事实层；完整零交易分钟显示真实 0，缺少分钟桶则显示等待回补。</div></aside></div>;
}

export default function DashboardClient({ initialSnapshot, initialRanking }: { initialSnapshot: DashboardSnapshot; initialRanking: RankingResponse }) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [capital, setCapital] = useState<TerminalCapital>(1_000);
  const [window, setWindow] = useState<TerminalWindow>("24h");
  const [includeOfficialOnly, setIncludeOfficialOnly] = useState(false);
  const [expandedPair, setExpandedPair] = useState<string | null>(null);
  const [evidencePairId, setEvidencePairId] = useState<string | null>(null);
  const [walletOpen, setWalletOpen] = useState(false);
  const [systemOpen, setSystemOpen] = useState(false);
  const [progressWindow, setProgressWindow] = useState<TerminalWindow | null>(null);
  const [ranking, setRanking] = useState<RankingResponse | null>(initialRanking);
  const [lastSuccessfulRefresh, setLastSuccessfulRefresh] = useState<string | null>(initialRanking.updatedAt);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copiedMessage, setCopiedMessage] = useState("");
  const rankingVersion = useRef(initialRanking.dataVersion);
  const rankingRequestActive = useRef(false);

  const rankingMatches = ranking?.capital === capital && ranking.window === window && (ranking.includeOfficialOnly ?? false) === includeOfficialOnly;
  const selectedStatus = rankingMatches ? ranking.windowStatus : snapshotWindowStatus(snapshot, window);
  const tableStatus = rankingMatches && ranking.rankingWindow !== window ? ranking.rankingWindowStatus : selectedStatus;
  const windowViews = useMemo(() => WINDOWS.map((item) => item.key === selectedStatus.key ? selectedStatus : snapshotWindowStatus(snapshot, item.key)), [snapshot, selectedStatus]);
  const pairs = rankingMatches ? ranking?.pairs ?? [] : [];
  const displayPairs = rankingMatches
    ? [...(ranking?.pairs ?? []), ...(ranking?.waitingPairs ?? [])]
    : [];
  const filteredPairCount = rankingMatches ? ranking?.eligiblePairCount ?? pairs.length : snapshot.universe?.activePairCount ?? pairs.length;
  const filteredPoolCount = rankingMatches ? ranking?.eligiblePoolCount ?? snapshot.universe?.activePoolCount ?? snapshot.publicMarket.poolCount : snapshot.universe?.activePoolCount ?? snapshot.publicMarket.poolCount;
  const evidencePair = displayPairs.find((pair) => pair.pairId === evidencePairId) ?? null;
  const positionPoolIds = useMemo(() => new Set(snapshot.positions.map((position) => position.poolAddress)), [snapshot.positions]);

  useEffect(() => {
    let disposed = false;
    let firstRequest = true;
    const refresh = async () => {
      if (disposed || rankingRequestActive.current) return;
      rankingRequestActive.current = true;
      try {
        const response = await fetch(`/api/rankings?capital=${capital}&window=${window}&includeOfficialOnly=${includeOfficialOnly ? "1" : "0"}`, { cache: "no-store", headers: { "cache-control": "no-cache" } });
        if (!response.ok) throw new Error(`ranking_${response.status}`);
        const payload = await response.json() as RankingResponse;
        if (disposed) return;
        if (payload.dataVersion !== rankingVersion.current || firstRequest) {
          rankingVersion.current = payload.dataVersion;
          setRanking(payload);
        }
        setLastSuccessfulRefresh(new Date().toISOString());
        setError(payload.rankingStatus === "PARTIAL_DATA"
          ? payload.selectionNotice
          : payload.rankingStatus === "NO_ACTIVITY" ? "" : payload.window !== "24h" && payload.pairs.length === 0
            ? `等待 ${payload.windowStatus.label} 回补：当前没有完整 Pool 进入排名`
            : "");
      } catch (reason: unknown) {
        if (!disposed && (reason as Error)?.name !== "AbortError") setError("排名接口数据源不可用，保留上次成功结果");
      } finally {
        firstRequest = false;
        rankingRequestActive.current = false;
        if (!disposed) setLoading(false);
      }
    };
    void refresh();
    const timer = globalThis.setInterval(() => { void refresh(); }, 15_000);
    const onVisibility = () => { if (document.visibilityState === "visible") void refresh(); };
    const onOnline = () => { void refresh(); };
    document.addEventListener("visibilitychange", onVisibility);
    globalThis.addEventListener("online", onOnline);
    return () => {
      disposed = true;
      globalThis.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      globalThis.removeEventListener("online", onOnline);
    };
  }, [capital, window, includeOfficialOnly]);

  function changeCapital(next: TerminalCapital) {
    if (next === capital) return;
    setLoading(true); setError(""); setExpandedPair(null); setCapital(next);
  }

  function changeWindow(next: TerminalWindow) {
    if (next === window) return;
    setLoading(true); setError(""); setExpandedPair(null); setWindow(next);
  }

  function handleUpdated(next: DashboardSnapshot) {
    setLoading(true); setSnapshot(next);
  }

  function copied(label: string) {
    setCopiedMessage(`${label}已复制`);
    globalThis.setTimeout(() => setCopiedMessage(""), 1400);
  }

  const showNet = ranking?.rankingBasis === "NET_PROFIT";
  const rankingLabel = ranking?.rankingBasis === "NET_PROFIT"
    ? "可执行净收益"
    : ranking?.rankingBasis === "LP_FEE_DENSITY" ? "24h LP Fee 密度" : "可执行手续费收益";
  const rankingNote = ranking?.rankingStatus === "NO_ACTIVITY"
    ? `${ranking.selectionNotice}；不生成所选窗口的虚假名次`
    : ranking?.rankingStatus === "PARTIAL_DATA"
      ? ranking.selectionNotice
      : ranking?.rankingBasis === "NET_PROFIT"
    ? "按预计净利润 USDC 降序"
    : ranking?.rankingBasis === "LP_FEE_DENSITY" ? "部分事实字段缺失，按 LP Fee / TVL 降序" : "TVL 比例估算，未扣除区间外影响；净收益模型尚未完成";
  const showSelectionNotice = Boolean(rankingMatches && ranking && (ranking.rankingStatus !== "ACTIVE" || ranking.fallbackWindow));
  return <main className="terminal-shell">
    <StatusBar snapshot={snapshot} lastSuccessfulRefresh={lastSuccessfulRefresh} onSystem={() => setSystemOpen(true)} onWallet={() => setWalletOpen(true)} />
    <section className="terminal-controls"><div className="control-group"><span>投入金额</span><div className="control-buttons">{CAPITAL_OPTIONS.map((item) => <button key={item} className={capital === item ? "active" : ""} onClick={() => changeCapital(item)} data-testid={`capital-${item}`}>${item.toLocaleString("en-US")}</button>)}</div></div><div className="control-group"><span>决策窗口</span><div className="control-buttons">{windowViews.map((item) => <WindowButton key={item.key} view={item} active={window === item.key} onClick={() => { changeWindow(item.key); setProgressWindow(item.key); }} />)}</div></div><div className="ranking-basis"><span>唯一默认排名</span><strong>{rankingLabel}</strong><small>{rankingNote}</small></div><div className="ranking-filter-badge" data-testid="default-research-filters"><span>默认筛选</span><strong>24h成交 &gt; $1,000 · 24h LP Fee &gt; $30 · TVL &gt; $5,000</strong></div><div className="terminal-count"><strong>{filteredPairCount} 个符合筛选 Pair</strong><br /><small>{filteredPoolCount} 个符合筛选 Pool · 官方数据 {snapshot.universe?.officialOnlyPoolCount ?? 0} · 隔离 {snapshot.universe?.quarantinedPoolCount ?? 0}</small><button className={`universe-toggle ${includeOfficialOnly ? "active" : ""}`} onClick={() => { setIncludeOfficialOnly((value) => !value); setLoading(true); setExpandedPair(null); }} data-testid="include-official-only">{includeOfficialOnly ? "隐藏官方池" : "显示低TVL/隔离池"}</button></div></section>
    {copiedMessage ? <div className="copy-toast" role="status">{copiedMessage}</div> : null}
    {loading ? <div className="ranking-loading" data-testid="ranking-loading">正在刷新 {capital.toLocaleString("en-US")}U × {window} 排名</div> : null}
    {error ? <div className="ranking-error" data-testid="ranking-error">{error}</div> : null}
    {showSelectionNotice && ranking ? <div className={`window-selection-notice ${ranking.rankingStatus.toLowerCase()}`} data-testid="window-selection-notice"><strong>{ranking.selectionNotice}</strong>{ranking.fallbackWindow ? <span>排名依据：{ranking.rankingWindowStatus.label} · 不是 {ranking.windowStatus.label} 排名</span> : null}</div> : null}
    <section className="terminal-table-wrap"><div className="table-scroll"><table className="terminal-table public-ranking-table"><colgroup><col className="col-rank" /><col className="col-pair" /><col className="col-pool" /><col className="col-price" /><col className="col-band" /><col className="col-tvl" /><col className="col-volume" /><col className="col-fee" /><col className="col-estimate" /><col className="col-verdict" /></colgroup><thead><tr><th>{rankingMatches && ranking?.fallbackWindow ? "参考排名" : "排名"}</th><th>交易对</th><th>推荐 Pool / Fee Tier</th><th>股票价格</th><th>24小时上下限</th><th>TVL</th><th>{tableStatus.label}成交量</th><th>{tableStatus.label} LP Fee</th><th>预计手续费收入</th><th>结论 / 原因</th></tr></thead><tbody>{displayPairs.map((pair) => <RankingRow key={pair.pairId} pair={pair} rank={pairs.findIndex((item) => item.pairId === pair.pairId) + 1} expanded={expandedPair === pair.pairId} onToggle={() => setExpandedPair((value) => value === pair.pairId ? null : pair.pairId)} onEvidence={() => setEvidencePairId(pair.pairId)} positionPoolIds={positionPoolIds} onCopied={copied} showNet={showNet} />)}</tbody></table></div></section>
    {!loading && displayPairs.length === 0 ? <div className="terminal-empty">{error || (selectedStatus.status === "UNAVAILABLE" ? "等待当前窗口数据源" : "等待可执行排名数据")}<small>{selectedStatus.reason ?? "官方 API 市场数据仍可在公开模式下使用"}</small></div> : null}
    {evidencePair ? <EvidenceDrawer pair={evidencePair} onClose={() => setEvidencePairId(null)} /> : null}
    {walletOpen ? <WalletModal snapshot={snapshot} onClose={() => setWalletOpen(false)} onUpdated={handleUpdated} /> : null}
    {systemOpen ? <SystemDrawer snapshot={snapshot} onClose={() => setSystemOpen(false)} /> : null}
    {progressWindow ? <ProgressDrawer snapshot={snapshot} view={progressWindow} onClose={() => setProgressWindow(null)} /> : null}
  </main>;
}
