import { escapeHtml, formatTimestamp } from "./format.mjs";

const DISPLAY_ACTIONS = Object.freeze({
  OPEN: "OPEN",
  HOLD: "HOLD",
  MOVE_CORE: "MOVE CORE",
  MOVE_BOTH: "MOVE BOTH",
  CLOSE: "CLOSE",
  UNAVAILABLE: "UNAVAILABLE",
});

function numberValue(value, digits = 2) {
  return Number.isFinite(value)
    ? value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : "等待证据";
}

function usd(value, digits = 2) {
  return Number.isFinite(value) ? `$${numberValue(value, digits)}` : "等待证据";
}

function rangeLabel(lower, upper) {
  return Number.isFinite(lower) && Number.isFinite(upper)
    ? `${numberValue(lower, 4)} – ${numberValue(upper, 4)}`
    : "等待合法 Tick";
}

export function displayAction(action) {
  return DISPLAY_ACTIONS[action] ?? "UNAVAILABLE";
}

function rowValues(row) {
  const best = row.best ?? row;
  return {
    pair: row.pair ?? `${row.symbol ?? ""}/USDC`,
    net24h: row.net24h ?? best.expectedNetFee24h,
    coreCapital: row.coreCapital ?? best.coreCapital,
    coreLower: row.coreLower ?? best.core?.lowerPrice,
    coreUpper: row.coreUpper ?? best.core?.upperPrice,
    bufferCapital: row.bufferCapital ?? best.bufferCapital,
    bufferLower: row.bufferLower ?? best.buffer?.lowerPrice,
    bufferUpper: row.bufferUpper ?? best.buffer?.upperPrice,
    action: row.action,
  };
}

export function renderRow(row) {
  const value = rowValues(row);
  return `<article class="optimizer-row" data-pool-address="${escapeHtml(row.poolAddress ?? "")}" role="row">
    <div class="row-grid">
      <div class="rank" role="cell">#${String(row.rank).padStart(2, "0")}</div>
      <div class="pair" role="cell"><strong>${escapeHtml(value.pair)}</strong></div>
      <div class="net" role="cell"><strong>${escapeHtml(usd(value.net24h, 2))}</strong></div>
      <div class="strategy" role="cell"><strong>${escapeHtml(usd(value.coreCapital, 0))}</strong><em>${escapeHtml(rangeLabel(value.coreLower, value.coreUpper))}</em></div>
      <div class="strategy" role="cell"><strong>${escapeHtml(usd(value.bufferCapital, 0))}</strong><em>${escapeHtml(rangeLabel(value.bufferLower, value.bufferUpper))}</em></div>
      <div class="action ${escapeHtml(displayAction(value.action).toLowerCase().replaceAll(" ", "-"))}" role="cell"><strong>${escapeHtml(displayAction(value.action))}</strong></div>
    </div>
  </article>`;
}

function renderStyles() {
  return `:root{--paper:#f5f4ed;--ink:#141413;--muted:#716f68;--soft:#96938b;--line:#dedbd0;--blue:#1b365d;--danger:#8a4e3d;--content:1180px;--columns:44px minmax(190px,1.6fr) minmax(135px,1fr) minmax(200px,1.2fr) minmax(200px,1.2fr) minmax(120px,.7fr)}*{box-sizing:border-box}html{min-height:100%;background:var(--paper)}body{min-height:100%;margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Microsoft YaHei",sans-serif;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased;overflow-wrap:anywhere}main{width:calc(100% - 40px);max-width:var(--content);margin:0 auto;padding:28px 0 64px}.masthead{display:flex;justify-content:space-between;align-items:end;gap:24px;padding:4px 10px 20px}.masthead h1{margin:0;color:var(--ink);font-size:21px;font-weight:700;letter-spacing:-.025em}.masthead p{margin:0;color:var(--muted);font-size:12px;text-align:right}.status-bar{display:flex;justify-content:space-between;gap:20px;padding:0 10px 14px;color:var(--muted);font-size:12px}.status-bar [data-state="warning"]{color:var(--danger)}.status-bar [data-state="fresh"]{color:#3e6650}.table-header,.row-grid{display:grid;grid-template-columns:var(--columns);column-gap:18px;align-items:center}.table-header{position:sticky;top:0;z-index:2;padding:11px 10px 9px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:rgba(245,244,237,.96);color:var(--soft);font-size:11px;letter-spacing:.06em}.table-header div:not(:first-child){text-align:right}.optimizer-row{padding:25px 10px 23px;border-bottom:1px solid var(--line)}.row-grid>div:not(:first-child){text-align:right}.rank{color:var(--blue);font:500 18px/1 Georgia,serif}.pair{min-width:0;text-align:left!important}.pair strong{overflow:hidden;font-family:"Iowan Old Style","Songti SC",STSong,Georgia,serif;font-size:23px;font-weight:750;letter-spacing:-.03em;line-height:1.05;text-overflow:ellipsis;white-space:nowrap}.net,.strategy,.action{display:grid;gap:4px;min-width:0}.net strong{color:var(--blue);font-family:"Iowan Old Style","Songti SC",STSong,Georgia,serif;font-size:25px;font-weight:750;line-height:1.05}.strategy strong{font-size:14px;font-weight:650;line-height:1.15}.strategy em{overflow:hidden;color:var(--muted);font-size:12px;font-style:normal;text-overflow:ellipsis;white-space:nowrap}.action strong{color:var(--blue);font-size:13px;font-weight:750;letter-spacing:.04em}.action.close strong{color:var(--danger)}.action.unavailable strong{color:var(--muted)}.empty-state{margin:24px 10px;padding:28px 0;color:var(--muted)}.empty-state strong{display:block;color:var(--danger);font-size:15px;letter-spacing:.08em}.empty-state span{display:block;margin-top:6px;font-size:13px}.empty-state .ready-count{color:var(--ink);font-size:18px;font-weight:700}.empty-state .reason{color:var(--muted)}footer{display:flex;gap:16px;flex-wrap:wrap;margin-top:36px;padding:16px 10px 0;border-top:1px solid var(--line);color:var(--muted);font-size:12px;line-height:1.7}footer a{color:var(--blue)}[hidden]{display:none!important}@media(max-width:900px){main{width:calc(100% - 28px);padding-top:20px}.table-header{display:none}.optimizer-row{padding:23px 6px 21px}.row-grid{grid-template-columns:38px minmax(0,1fr) minmax(150px,auto);grid-template-areas:"rank pair net" "rank core action" "rank buffer action";column-gap:14px;row-gap:11px;align-items:center}.row-grid>.rank{grid-area:rank;align-self:start;padding-top:4px}.row-grid>.pair{grid-area:pair}.row-grid>.net{grid-area:net}.row-grid>.strategy:nth-of-type(4){grid-area:core}.row-grid>.strategy:nth-of-type(5){grid-area:buffer}.row-grid>.action{grid-area:action;align-self:center}}@media(max-width:580px){main{width:calc(100% - 20px);padding:16px 0 44px}.masthead{display:block;padding:0 4px 14px}.masthead h1{font-size:19px}.masthead p{margin-top:4px;text-align:left;font-size:11px}.status-bar{padding:0 4px 10px;font-size:11px}.optimizer-row{padding:21px 4px 19px}.row-grid{grid-template-columns:30px minmax(0,1fr) minmax(112px,auto);column-gap:9px;row-gap:10px}.pair strong{font-size:20px}.net strong{font-size:21px}.strategy strong{font-size:12px}.strategy em{font-size:10px}.empty-state{margin-left:4px;margin-right:4px}footer{padding-left:4px;padding-right:4px;font-size:11px}}`;
}

export function renderPage({ fetchedAt, poolCount, snapshotHash = null, config }) {
  const initialTimestamp = formatTimestamp(fetchedAt);
  const runtimeVersion = snapshotHash ? `?v=${encodeURIComponent(snapshotHash.slice(0, 12))}` : "";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#f5f4ed"><meta name="data-source" content="./top3.json"><title>RWA / USDC LP Optimizer</title><style>${renderStyles()}</style></head><body><main data-top3-source="./top3.json">
<header class="masthead"><div><h1>RWA / USDC LP Optimizer</h1><p>Raydium · 固定资金 ${escapeHtml(`$${config.capital.toLocaleString("en-US")}`)} · 只保留 Top 3</p></div><p>自动执行：关闭</p></header>
<div class="status-bar" aria-live="polite"><span id="live-status" data-state="warning">读取 top3.json</span><span id="market-count">等待 top3.json</span></div>
<section class="ranking" aria-label="RWA / USDC Top 3" role="table"><div class="table-header" role="row"><div role="columnheader">#</div><div role="columnheader">Pair</div><div role="columnheader">Net 24H</div><div role="columnheader">Core</div><div role="columnheader">Buffer</div><div role="columnheader">Action</div></div><div id="ranking-list" class="ranking-list" aria-live="polite"></div><div id="empty-state" class="empty-state" hidden></div></section>
<footer>唯一数据源：mobile-dashboard/top3.json · 仅展示完整证据门槛通过的 Top 3 · <span id="observed-wrap"${initialTimestamp ? "" : " hidden"}>读取：<span id="observed-at">${escapeHtml(initialTimestamp ?? "")}</span></span><a href="https://github.com/fengxiong111/lp-decision-os">查看源码</a></footer></main><script type="module" src="./runtime.js${runtimeVersion}"></script></body></html>`;
}

export { renderStyles };
