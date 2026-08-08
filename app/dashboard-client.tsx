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

function RankingListItem({ pair, rank, expanded, onToggle, onEvidence, positionPoolIds, onCopied, showNet }: { pair: RankingPair; rank: number; expanded: boolean; onToggle: () => void; onEvidence: () => void; positionPoolIds: Set<string>; onCopied: (label: string) => void; showNet: boolean }) {
  const pool = pair.recommendedPool ?? pair.allPools[0] ?? null;
  const rowId = pair.symbol.replace(/[^a-zA-Z0-9]+/g, "-");
  return <article className={`kami-ranking-item ${expanded ? "expanded" : ""}`}>
    <button className="kami-ranking-main ranking-row" onClick={onToggle} data-testid={`pair-row-${rowId}`}>
      <span className="kami-list-rank">{rank > 0 ? String(rank).padStart(2, "0") : "—"}</span>
      <span className="kami-list-asset"><strong>{pair.symbol}</strong><small>{pair.underlying} · {pair.allPools.length} 个 Pool</small></span>
      <span className="kami-list-metric"><small>TVL</small><strong>{money(pair.tvl ?? pool?.tvl ?? null, 0)}</strong></span>
      <span className="kami-list-metric"><small>24h 成交量</small><strong>{money(pair.volume ?? pool?.volume ?? null, 0)}</strong></span>
      <span className="kami-list-metric"><small>24h LP Fee</small><strong>{money(pair.lpFee ?? pool?.lpFee ?? null, 2)}</strong></span>
      <span className="kami-list-estimate"><small>预计手续费</small><strong>{money(pair.estimatedFeeIncome.value, 4)}</strong></span>
      <span className="kami-list-pool"><small>{pool?.feeTier ?? "Fee Tier暂无"}</small><b>{shortAddress(pool?.poolAddress)}</b></span>
      <span className="kami-list-arrow" aria-hidden="true">{expanded ? "−" : "+"}</span>
    </button>
    <div className="kami-list-reason"><span>{pair.shortReason}</span><button onClick={onEvidence} data-testid={`decision-${rowId}`}>查看依据</button></div>
    {expanded ? <PoolSubtable pair={pair} positionPoolIds={positionPoolIds} onCopied={onCopied} showNet={showNet} /> : null}
  </article>;
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

export default function DashboardClient({ initialSnapshot, initialRanking }: { initialSnapshot: DashboardSnapshot; initialRanking: RankingResponse }) {
  const snapshot = initialSnapshot;
  const capital: TerminalCapital = 1_000;
  const window: TerminalWindow = "24h";
  const includeOfficialOnly = false;
  const [expandedPair, setExpandedPair] = useState<string | null>(null);
  const [evidencePairId, setEvidencePairId] = useState<string | null>(null);
  const [ranking, setRanking] = useState<RankingResponse | null>(initialRanking);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copiedMessage, setCopiedMessage] = useState("");
  const rankingVersion = useRef(initialRanking.dataVersion);
  const rankingRequestActive = useRef(false);

  const rankingMatches = ranking?.capital === capital && ranking.window === window && (ranking.includeOfficialOnly ?? false) === includeOfficialOnly;
  const selectedStatus = rankingMatches ? ranking.windowStatus : snapshotWindowStatus(snapshot, window);
  const pairs = rankingMatches ? ranking?.pairs ?? [] : [];
  const displayPairs = rankingMatches
    ? [...(ranking?.pairs ?? []), ...(ranking?.waitingPairs ?? [])]
    : [];
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

  function copied(label: string) {
    setCopiedMessage(`${label}已复制`);
    globalThis.setTimeout(() => setCopiedMessage(""), 1400);
  }

  const showNet = ranking?.rankingBasis === "NET_PROFIT";
  const showSelectionNotice = Boolean(rankingMatches && ranking && (ranking.rankingStatus !== "ACTIVE" || ranking.fallbackWindow));
  return <main className="terminal-shell">
    {copiedMessage ? <div className="copy-toast" role="status">{copiedMessage}</div> : null}
    {loading ? <div className="ranking-loading" data-testid="ranking-loading">正在刷新 1,000U 排名</div> : null}
    {error ? <div className="ranking-error" data-testid="ranking-error">{error}</div> : null}
    {showSelectionNotice && ranking ? <div className={`window-selection-notice ${ranking.rankingStatus.toLowerCase()}`} data-testid="window-selection-notice"><strong>{ranking.selectionNotice}</strong>{ranking.fallbackWindow ? <span>排名依据：{ranking.rankingWindowStatus.label} · 不是 {ranking.windowStatus.label} 排名</span> : null}</div> : null}
    <section className="kami-ranking"><div className="kami-ranking-list">{displayPairs.map((pair) => <RankingListItem key={pair.pairId} pair={pair} rank={pairs.findIndex((item) => item.pairId === pair.pairId) + 1} expanded={expandedPair === pair.pairId} onToggle={() => setExpandedPair((value) => value === pair.pairId ? null : pair.pairId)} onEvidence={() => setEvidencePairId(pair.pairId)} positionPoolIds={positionPoolIds} onCopied={copied} showNet={showNet} />)}</div></section>
    {!loading && displayPairs.length === 0 ? <div className="terminal-empty">{error || (selectedStatus.status === "UNAVAILABLE" ? "等待当前窗口数据源" : "等待可执行排名数据")}<small>{selectedStatus.reason ?? "官方 API 市场数据仍可在公开模式下使用"}</small></div> : null}
    <footer className="kami-footer">数据来源：Raydium 官方 API · 预计值未扣除无常损失、进出滑点与再平衡成本。</footer>
    {evidencePair ? <EvidenceDrawer pair={evidencePair} onClose={() => setEvidencePairId(null)} /> : null}
  </main>;
}
