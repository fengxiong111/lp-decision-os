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
    <div class="row-tools"><button class="why-trigger" type="button" data-pool-address="${escapeHtml(row.poolAddress ?? "")}">WHY</button></div>
  </article>`;
}

function renderStyles() {
  return `
:root{--paper:#f5f4ed;--ink:#141413;--muted:#716f68;--soft:#96938b;--line:#dedbd0;--blue:#1b365d;--danger:#8a4e3d;--warn:#8a6b35;--pass:#3e6650;--content:1180px;--columns:44px minmax(190px,1.6fr) minmax(135px,1fr) minmax(200px,1.2fr) minmax(200px,1.2fr) minmax(120px,.7fr)}
*{box-sizing:border-box}html{min-height:100%;background:var(--paper)}body{min-height:100%;margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Microsoft YaHei",sans-serif;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased;overflow-wrap:anywhere}main{width:calc(100% - 40px);max-width:var(--content);margin:0 auto;padding:28px 0 44px}
.masthead{display:flex;justify-content:space-between;align-items:end;gap:24px;padding:4px 10px 20px}.masthead h1{margin:0;color:var(--ink);font-size:25px;font-weight:700;letter-spacing:-.035em}.masthead p{margin:0;color:var(--muted);font-size:12px;text-align:right}.status-bar{display:flex;justify-content:space-between;gap:20px;padding:0 10px 14px;color:var(--muted);font-size:13px}.status-bar [data-state="warning"]{color:var(--danger)}.status-bar [data-state="fresh"]{color:var(--pass)}#market-count{color:var(--ink);font-size:16px;font-weight:700}
.table-header,.row-grid{display:grid;grid-template-columns:var(--columns);column-gap:18px;align-items:center}.table-header{position:sticky;top:0;z-index:2;padding:11px 10px 9px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:rgba(245,244,237,.96);color:var(--soft);font-size:11px;letter-spacing:.06em}.table-header div:not(:first-child){text-align:right}.optimizer-row{padding:25px 10px 14px;border-bottom:1px solid var(--line)}.row-grid>div:not(:first-child){text-align:right}.rank{color:var(--blue);font:500 18px/1 Georgia,serif}.pair{min-width:0;text-align:left!important}.pair strong{overflow:hidden;font-family:"Iowan Old Style","Songti SC",STSong,Georgia,serif;font-size:23px;font-weight:750;letter-spacing:-.03em;line-height:1.05;text-overflow:ellipsis;white-space:nowrap}.net,.strategy,.action{display:grid;gap:4px;min-width:0}.net strong{color:var(--blue);font-family:"Iowan Old Style","Songti SC",STSong,Georgia,serif;font-size:25px;font-weight:750;line-height:1.05}.strategy strong{font-size:14px;font-weight:650;line-height:1.15}.strategy em{overflow:hidden;color:var(--muted);font-size:12px;font-style:normal;text-overflow:ellipsis;white-space:nowrap}.action strong{color:var(--blue);font-size:13px;font-weight:750;letter-spacing:.04em}.action.close strong{color:var(--danger)}.action.unavailable strong{color:var(--muted)}.row-tools{display:flex;justify-content:flex-end;margin-top:10px}.why-trigger{border:0;padding:0;background:transparent;color:var(--muted);font:600 11px/1.2 inherit;letter-spacing:.1em;cursor:pointer}.why-trigger:hover{color:var(--blue)}
.empty-state{margin:12px 10px;padding:18px 0;min-height:90px;color:var(--muted)}.empty-state strong{display:block;color:var(--ink);font-size:22px;font-weight:700;letter-spacing:-.02em}.empty-state span{display:block;margin-top:5px;font-size:13px}.empty-state .ready-count{display:none}.empty-state .reason{color:var(--muted)}
.diagnostics-section{margin:18px 10px 0;border-top:1px solid var(--line)}.verification-panel{padding:0}.verification-panel summary{padding:14px 0;color:var(--ink);font-size:13px;font-weight:700;cursor:pointer;list-style:none}.verification-panel summary::-webkit-details-marker{display:none}.verification-panel summary::after{content:"＋";float:right;color:var(--muted);font-size:16px;font-weight:400}.verification-panel[open] summary::after{content:"−"}.verification-list{padding:0 0 12px}.verification-row{display:grid;grid-template-columns:minmax(150px,1.2fr) 100px minmax(160px,1fr) 40px;gap:16px;padding:9px 0;border-top:1px solid rgba(222,219,208,.65);font-size:12px}.verification-row .pair-label{font-weight:650}.status-ready{color:var(--pass)}.status-near{color:var(--warn)}.status-blocked{color:var(--danger)}.drawer-status.status-ready{font-size:15px}.blocker{color:var(--muted);text-align:right}.verification-why{justify-self:end}
.why-drawer{position:fixed;inset:0 0 0 auto;z-index:4;width:min(480px,100%);padding:28px 26px;background:rgba(250,249,243,.98);box-shadow:-12px 0 40px rgba(20,20,19,.08);overflow:auto}.why-drawer header{display:flex;justify-content:space-between;align-items:start;gap:20px;border-bottom:1px solid var(--line);padding-bottom:16px}.why-drawer h2{margin:0;font-size:20px;letter-spacing:-.025em}.drawer-close{border:0;background:transparent;color:var(--muted);font-size:22px;line-height:1;cursor:pointer}.drawer-status{margin-top:8px;font-size:13px;font-weight:700}.evidence-list{margin:22px 0 0}.evidence-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;padding:10px 0;border-bottom:1px solid rgba(222,219,208,.65)}.evidence-row strong{font-size:13px}.evidence-row small{display:block;margin-top:2px;color:var(--muted);font-size:11px}.evidence-status{font-size:11px;font-weight:700;letter-spacing:.06em}.net-range{margin-top:22px;padding-top:16px;border-top:1px solid var(--line)}.net-range h3{margin:0 0 10px;font-size:12px;letter-spacing:.08em}.net-range-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.net-range-grid div{padding:10px 0}.net-range-grid strong{display:block;font-size:15px}.net-range-grid small{color:var(--muted);font-size:10px}.volatility{margin-top:20px;color:var(--muted);font-size:12px}.volatility strong{color:var(--ink)}
footer{display:flex;gap:16px;flex-wrap:wrap;margin-top:26px;padding:16px 10px 0;border-top:1px solid var(--line);color:var(--muted);font-size:12px;line-height:1.7}footer a{color:var(--blue)}[hidden]{display:none!important}
@media(max-width:900px){main{width:calc(100% - 28px);padding-top:20px}.table-header{display:none}.optimizer-row{padding:23px 6px 13px}.row-grid{grid-template-columns:38px minmax(0,1fr) minmax(150px,auto);grid-template-areas:"rank pair net" "rank core action" "rank buffer action";column-gap:14px;row-gap:11px;align-items:center}.row-grid>.rank{grid-area:rank;align-self:start;padding-top:4px}.row-grid>.pair{grid-area:pair}.row-grid>.net{grid-area:net}.row-grid>.strategy:nth-of-type(4){grid-area:core}.row-grid>.strategy:nth-of-type(5){grid-area:buffer}.row-grid>.action{grid-area:action;align-self:center}.row-tools{margin-top:9px}.verification-row{grid-template-columns:minmax(120px,1fr) 90px minmax(120px,1fr) 40px;gap:10px}}
@media(max-width:580px){main{width:calc(100% - 20px);padding:16px 0 34px}.masthead{display:block;padding:0 4px 14px}.masthead h1{font-size:22px}.masthead p{margin-top:4px;text-align:left;font-size:11px}.status-bar{padding:0 4px 10px;font-size:11px}.optimizer-row{padding:21px 4px 12px}.row-grid{grid-template-columns:30px minmax(0,1fr) minmax(112px,auto);column-gap:9px;row-gap:10px}.pair strong{font-size:20px}.net strong{font-size:21px}.strategy strong{font-size:12px}.strategy em{font-size:10px}.empty-state{margin-left:4px;margin-right:4px;min-height:76px}.diagnostics-section{margin-left:4px;margin-right:4px}.verification-row{grid-template-columns:minmax(88px,1fr) 70px minmax(80px,1fr) 34px;gap:7px;font-size:11px}.blocker{text-align:right}.why-drawer{padding:22px 18px}.net-range-grid{gap:6px}footer{padding-left:4px;padding-right:4px;font-size:11px}}
`;
}

export function renderPage({ fetchedAt, snapshotHash = null, config }) {
  const initialTimestamp = formatTimestamp(fetchedAt);
  const runtimeVersion = snapshotHash ? `?v=${encodeURIComponent(snapshotHash.slice(0, 12))}` : "";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#f5f4ed"><meta name="data-source" content="./top3.json"><title>RWA / USDC LP Optimizer</title><style>${renderStyles()}</style></head><body><main data-top3-source="./top3.json">
<header class="masthead"><div><h1>RWA / USDC LP Optimizer</h1><p>Raydium · 固定资金 ${escapeHtml(`$${config.capital.toLocaleString("en-US")}`)} · 只保留 Top 3</p></div><p>自动执行：关闭</p></header>
<div class="status-bar" aria-live="polite"><span id="live-status" data-state="warning">读取 top3.json</span><span id="market-count">READY 0 / 3</span></div>
<section class="ranking" aria-label="RWA / USDC Top 3" role="table"><div class="table-header" role="row"><div role="columnheader">#</div><div role="columnheader">Pair</div><div role="columnheader">Net 24H</div><div role="columnheader">Core</div><div role="columnheader">Buffer</div><div role="columnheader">Action</div></div><div id="ranking-list" class="ranking-list" aria-live="polite"></div><div id="empty-state" class="empty-state" hidden></div></section>
<section class="diagnostics-section" aria-label="WHY / 正在验证"><details id="verification-panel" class="verification-panel"><summary>正在验证</summary><div id="verification-list" class="verification-list"></div></details></section>
<aside id="why-drawer" class="why-drawer" aria-label="WHY evidence" hidden></aside>
<footer>唯一数据源：mobile-dashboard/top3.json · 仅展示完整证据门槛通过的 Top 3 · <span id="observed-wrap"${initialTimestamp ? "" : " hidden"}>读取：<span id="observed-at">${escapeHtml(initialTimestamp ?? "")}</span></span><a href="https://github.com/fengxiong111/lp-decision-os">查看源码</a></footer></main><script type="module" src="./runtime.js${runtimeVersion}"></script></body></html>`;
}

export { renderStyles };
