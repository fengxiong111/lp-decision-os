import { escapeHtml, formatTimestamp } from "./format.mjs";

const DISPLAY_ACTIONS = Object.freeze({
  OPEN_READY: "可考虑",
  WATCH: "观察",
  REVIEW: "观察",
  BLOCKED: "暂停",
});

function numberValue(value, digits = 2) {
  return Number.isFinite(value)
    ? value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : "等待计算";
}

function usd(value, digits = 2) {
  return Number.isFinite(value) ? `$${numberValue(value, digits)}` : "等待计算";
}

function dailyNet(value) {
  if (!Number.isFinite(value)) return "等待计算";
  return `${value >= 0 ? "+" : "−"}${usd(Math.abs(value), 2)}/天`;
}

function grossFeeLabel(value) {
  return Number.isFinite(value) ? `${usd(value, 2)}/天` : "等待计算";
}

function feeTierLabel(value) {
  return Number.isFinite(value) ? `${numberValue(value * 100, 2)}%` : "等待计算";
}

function pairLabel(pair) {
  return String(pair ?? "").replace("/", " / ");
}

export function displayAction(action) {
  return DISPLAY_ACTIONS[action] ?? "暂停";
}

function rowValues(row) {
  return {
    rank: row.rank,
    pair: pairLabel(row.pair ?? `${row.symbol ?? ""}/USDC`),
    tvl: row.tvl,
    volume24h: row.volume24h,
    lpFee24h: row.lpFee24h,
    feeTier: row.feeTier,
    grossFeeEstimate: row.grossFeeEstimate,
    netEstimate: row.netEstimate,
    action: row.action,
  };
}

function renderNet(value) {
  if (Number.isFinite(value.netEstimate)) {
    return `<strong>${escapeHtml(dailyNet(value.netEstimate))}</strong><small>毛收益估算：${escapeHtml(grossFeeLabel(value.grossFeeEstimate))} · 风险已校正</small>`;
  }
  return `<strong>估算中</strong><small>毛收益估算：${escapeHtml(grossFeeLabel(value.grossFeeEstimate))}</small><small>净收益：等待风险校正</small>`;
}

export function renderRow(row) {
  const value = rowValues(row);
  const actionClass = String(value.action ?? "BLOCKED").toLowerCase().replaceAll("_", "-");
  return `<article class="optimizer-row" data-pool-address="${escapeHtml(row.poolAddress ?? "")}" role="row">
    <div class="row-grid">
      <div class="rank" role="cell"><strong>${escapeHtml(String(value.rank ?? "").padStart(2, "0"))}</strong></div>
      <div class="pool" role="cell"><strong>${escapeHtml(value.pair)}</strong><small>Fee Tier ${escapeHtml(feeTierLabel(value.feeTier))}</small></div>
      <div class="volume" role="cell"><strong>${escapeHtml(usd(value.volume24h, 0))}</strong></div>
      <div class="lp-fee" role="cell"><strong>${escapeHtml(usd(value.lpFee24h, 2))}</strong></div>
      <div class="tvl" role="cell"><strong>${escapeHtml(usd(value.tvl, 0))}</strong></div>
      <div class="fee" role="cell"><strong>${escapeHtml(feeTierLabel(value.feeTier))}</strong></div>
      <div class="net" role="cell">${renderNet(value)}</div>
      <div class="action ${escapeHtml(actionClass)}" role="cell"><strong>${escapeHtml(displayAction(value.action))}</strong></div>
    </div>
    <div class="row-tools"><button class="details-trigger" type="button" data-pool-address="${escapeHtml(row.poolAddress ?? "")}">详情</button></div>
  </article>`;
}

function renderStyles() {
  return `
:root{--heat-columns:minmax(42px,.35fr) minmax(210px,1.8fr) minmax(150px,1.2fr) minmax(150px,1.2fr) minmax(130px,1fr) minmax(105px,.8fr)}.tabs{display:flex;gap:24px;margin:0 10px 16px;border-bottom:1px solid var(--line)}.tab{border:0;border-bottom:2px solid transparent;margin-bottom:-1px;padding:0 0 10px;background:transparent;color:var(--soft);font:650 13px/1.2 inherit;cursor:pointer}.tab.active,.tab[aria-selected="true"]{border-bottom-color:var(--blue);color:var(--ink)}.tab:hover{color:var(--blue)}.heat-header,.heat-grid{display:grid;grid-template-columns:var(--heat-columns);column-gap:16px;align-items:center}.heat-header{position:sticky;top:0;z-index:2;padding:11px 10px 9px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:rgba(245,244,237,.96);color:var(--soft);font-size:11px;letter-spacing:.06em}.heat-header div:not(:first-child),.heat-grid>div:not(:first-child){text-align:right}.heat-row{padding:20px 10px 18px;border-bottom:1px solid var(--line)}
@media(max-width:1000px){.heat-header{display:none!important}.heat-grid{grid-template-columns:minmax(0,1fr) minmax(170px,auto);grid-template-areas:"rank pool" "volume lpfee" "tvl fee" !important;column-gap:14px;row-gap:12px}.heat-grid>.rank{grid-area:rank!important}.heat-grid>.pool{grid-area:pool!important}.heat-grid>.volume{grid-area:volume!important}.heat-grid>.lp-fee{grid-area:lpfee!important}.heat-grid>.tvl{grid-area:tvl!important}.heat-grid>.fee{grid-area:fee!important}}
@media(max-width:1000px){.row-grid{grid-template-areas:"rank pool" "volume lpfee" "tvl fee" "net action" !important}.row-grid>.rank{grid-area:rank!important}.row-grid>.pool{grid-area:pool!important}.row-grid>.volume{grid-area:volume!important}.row-grid>.lp-fee{grid-area:lpfee!important}.row-grid>.tvl{grid-area:tvl!important}.row-grid>.fee{grid-area:fee!important}.row-grid>.net{grid-area:net!important}.row-grid>.action{grid-area:action!important}}.volume strong,.lp-fee strong{font-size:14px;font-weight:600;line-height:1.05;white-space:nowrap}.strategy-details{margin-top:22px;padding-top:16px;border-top:1px solid var(--line)}.strategy-details h3,.strategy-detail h3{margin:0 0 10px;color:var(--muted);font-size:11px;letter-spacing:.08em}.strategy-detail{display:grid;grid-template-columns:90px 100px minmax(0,1fr);gap:14px;align-items:baseline;padding:10px 0;border-top:1px solid rgba(222,219,208,.65)}.strategy-detail strong{font-size:15px}.strategy-detail span{color:var(--muted);font-size:13px}
:root{--paper:#f5f4ed;--ink:#141413;--muted:#716f68;--soft:#96938b;--line:#dedbd0;--blue:#1b365d;--danger:#8a4e3d;--warn:#8a6b35;--pass:#3e6650;--content:1220px;--columns:minmax(42px,.35fr) minmax(190px,1.7fr) minmax(110px,1fr) minmax(110px,1fr) minmax(100px,.85fr) minmax(90px,.75fr) minmax(190px,1.5fr) minmax(80px,.7fr)}
*{box-sizing:border-box}html{min-height:100%;background:var(--paper)}body{min-height:100%;margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Microsoft YaHei",sans-serif;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased;overflow-wrap:anywhere}main{width:calc(100% - 40px);max-width:var(--content);margin:0 auto;padding:30px 0 44px}
.masthead{display:flex;justify-content:space-between;align-items:end;gap:24px;padding:4px 10px 22px}.masthead h1{margin:0;color:var(--ink);font-size:27px;font-weight:750;letter-spacing:-.04em}.masthead p{margin:0;color:var(--muted);font-size:13px;text-align:right}.status-bar{display:flex;justify-content:flex-end;gap:20px;padding:0 10px 14px;color:var(--muted);font-size:13px}.status-bar [data-state="warning"]{color:var(--danger)}.status-bar [data-state="fresh"]{color:var(--pass)}
.table-header,.row-grid{display:grid;grid-template-columns:var(--columns);column-gap:16px;align-items:center}.table-header{position:sticky;top:0;z-index:2;padding:11px 10px 9px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:rgba(245,244,237,.96);color:var(--soft);font-size:11px;letter-spacing:.06em}.table-header div:not(:first-child){text-align:right}.optimizer-row{padding:25px 10px 14px;border-bottom:1px solid var(--line)}.row-grid>div:not(:first-child){text-align:right}.rank{color:var(--soft);text-align:left!important}.rank strong{font-size:13px;font-weight:500}.pool{min-width:0;text-align:left!important}.pool strong{display:block;overflow:hidden;font-family:"Iowan Old Style","Songti SC",STSong,Georgia,serif;font-size:24px;font-weight:750;letter-spacing:-.035em;line-height:1.05;text-overflow:ellipsis;white-space:nowrap}.pool small{display:block;overflow:hidden;margin-top:6px;color:var(--muted);font-size:11px;line-height:1.2;text-overflow:ellipsis;white-space:nowrap}.net,.strategy{display:grid;gap:4px;min-width:0}.net strong{color:var(--blue);font-size:20px;font-weight:750;line-height:1.05;white-space:nowrap}.net small{color:var(--muted);font-size:10px;line-height:1.2;white-space:nowrap}.tvl strong{font-size:16px;font-weight:650;line-height:1.05;white-space:nowrap}.fee strong{font-size:14px;font-weight:600;line-height:1.05;white-space:nowrap}.strategy strong{font-size:14px;font-weight:650;line-height:1.15;white-space:nowrap}.strategy em{overflow:hidden;color:var(--muted);font-size:12px;font-style:normal;text-overflow:ellipsis;white-space:nowrap}.action strong{color:var(--blue);font-size:13px;font-weight:750;letter-spacing:.04em;white-space:nowrap}.action.blocked strong{color:var(--danger)}.action.review strong{color:var(--warn)}.action.watch strong{color:var(--muted)}.row-tools{display:flex;justify-content:flex-end;margin-top:10px}.details-trigger{border:0;padding:0;background:transparent;color:var(--muted);font:600 11px/1.2 inherit;cursor:pointer}.details-trigger:hover{color:var(--blue)}
.opportunity-evidence{margin:22px 0 0;padding-top:16px;border-top:1px solid var(--line)}.opportunity-evidence h3{margin:0 0 10px;color:var(--muted);font-size:11px;letter-spacing:.08em}.opportunity-evidence>div{display:flex;justify-content:space-between;align-items:baseline;gap:16px}.opportunity-evidence strong{color:var(--blue);font-size:22px}.opportunity-evidence small{display:block;margin-top:6px;color:var(--muted);font-size:11px}
.empty-state{margin:12px 10px;padding:16px 0;min-height:72px;color:var(--muted)}.empty-state strong{display:block;color:var(--ink);font-size:22px;font-weight:700;letter-spacing:-.02em}.empty-state span{display:block;margin-top:5px;font-size:13px}.empty-state .ready-count{display:none}.empty-state .reason{color:var(--muted)}
.diagnostics-section{margin:18px 10px 0;border-top:1px solid var(--line)}.verification-panel{padding:0}.verification-panel summary{padding:14px 0;color:var(--ink);font-size:13px;font-weight:700;cursor:pointer;list-style:none}.verification-panel summary::-webkit-details-marker{display:none}.verification-panel summary::after{content:"＋";float:right;color:var(--muted);font-size:16px;font-weight:400}.verification-panel[open] summary::after{content:"−"}.verification-list{padding:0 0 12px}.verification-row{display:grid;grid-template-columns:minmax(150px,1.2fr) 100px minmax(160px,1fr) 40px;gap:16px;padding:9px 0;border-top:1px solid rgba(222,219,208,.65);font-size:12px}.verification-row .pair-label{font-weight:650}.status-ready{color:var(--pass)}.status-near{color:var(--warn)}.status-blocked{color:var(--danger)}.drawer-status.status-ready{font-size:15px}.blocker{color:var(--muted);text-align:right}.verification-details{justify-self:end}
.why-drawer{position:fixed;inset:0 0 0 auto;z-index:4;width:min(480px,100%);padding:28px 26px;background:rgba(250,249,243,.98);box-shadow:-12px 0 40px rgba(20,20,19,.08);overflow:auto}.why-drawer header{display:flex;justify-content:space-between;align-items:start;gap:20px;border-bottom:1px solid var(--line);padding-bottom:16px}.why-drawer h2{margin:0;font-size:20px;letter-spacing:-.025em}.drawer-close{border:0;background:transparent;color:var(--muted);font-size:22px;line-height:1;cursor:pointer}.drawer-status{margin-top:8px;font-size:13px;font-weight:700}.drawer-meta{margin-top:4px;color:var(--muted);font-size:12px}.evidence-list{margin:22px 0 0}.evidence-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;padding:10px 0;border-bottom:1px solid rgba(222,219,208,.65)}.evidence-row strong{font-size:13px}.evidence-row small{display:block;margin-top:2px;color:var(--muted);font-size:11px}.evidence-status{font-size:11px;font-weight:700;letter-spacing:.06em}.net-range{margin-top:22px;padding-top:16px;border-top:1px solid var(--line)}.net-range h3{margin:0 0 10px;font-size:12px;letter-spacing:.08em}.net-range-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.net-range-grid div{padding:10px 0}.net-range-grid strong{display:block;font-size:15px}.net-range-grid small{color:var(--muted);font-size:10px}.volatility{margin-top:20px;color:var(--muted);font-size:12px}.volatility strong{color:var(--ink)}
footer{display:flex;gap:16px;flex-wrap:wrap;margin-top:26px;padding:16px 10px 0;border-top:1px solid var(--line);color:var(--muted);font-size:12px;line-height:1.7}footer a{color:var(--blue)}[hidden]{display:none!important}
@media(max-width:1000px){main{width:calc(100% - 28px);padding-top:20px}.table-header{display:none}.optimizer-row{padding:23px 6px 13px}.row-grid{grid-template-columns:minmax(0,1fr) minmax(170px,auto);grid-template-areas:"rank pool" "net tvl" "fee action" "core buffer";column-gap:14px;row-gap:12px;align-items:center}.row-grid>.rank{grid-area:rank}.row-grid>.pool{grid-area:pool}.row-grid>.net{grid-area:net}.row-grid>.tvl{grid-area:tvl}.row-grid>.fee{grid-area:fee}.row-grid>.strategy:nth-of-type(6){grid-area:core}.row-grid>.strategy:nth-of-type(7){grid-area:buffer}.row-grid>.action{grid-area:action}.row-tools{margin-top:9px}.verification-row{grid-template-columns:minmax(120px,1fr) 90px minmax(120px,1fr) 40px;gap:10px}}
@media(max-width:580px){main{width:calc(100% - 20px);padding:16px 0 34px}.masthead{display:block;padding:0 4px 14px}.masthead h1{font-size:22px}.masthead p{margin-top:4px;text-align:left;font-size:11px}.status-bar{justify-content:flex-start;padding:0 4px 10px;font-size:11px}.optimizer-row{padding:21px 4px 12px}.row-grid{grid-template-columns:minmax(0,1fr) minmax(118px,auto);column-gap:9px;row-gap:10px}.pool strong{font-size:21px}.net strong{font-size:19px}.net small{font-size:9px}.tvl strong{font-size:15px}.fee strong{font-size:13px}.strategy strong{font-size:12px}.strategy em{font-size:10px}.empty-state{margin-left:4px;margin-right:4px;min-height:60px}.diagnostics-section{margin-left:4px;margin-right:4px}.verification-row{grid-template-columns:minmax(88px,1fr) 70px minmax(80px,1fr) 34px;gap:7px;font-size:11px}.blocker{text-align:right}.why-drawer{padding:22px 18px}.net-range-grid{gap:6px}footer{padding-left:4px;padding-right:4px;font-size:11px}}
`;
}

export function renderPage({ fetchedAt, snapshotHash = null, runtimeVersion = null, config }) {
  const initialTimestamp = formatTimestamp(fetchedAt);
  const runtimeQuery = runtimeVersion ?? snapshotHash;
  const runtimeSrc = runtimeQuery ? `?v=${encodeURIComponent(runtimeQuery.slice(0, 12))}` : "";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#f5f4ed"><meta name="data-source" content="./top3.json"><title>RWA / USDC LP 优化器</title><style>${renderStyles()}</style></head><body><main data-top3-source="./top3.json">
<header class="masthead"><div><h1>RWA / USDC LP 优化器</h1><p>Raydium · 模拟资金 ${escapeHtml(`$${config.capital.toLocaleString("en-US")}`)} · Top 3</p></div></header>
<div class="status-bar" aria-live="polite"><span id="live-status" data-state="warning">等待计算</span></div>
<nav class="tabs" role="tablist" aria-label="市场榜单切换"><button id="tab-opportunity" class="tab active" type="button" role="tab" aria-selected="true" aria-controls="opportunity-view">推荐机会</button><button id="tab-heat" class="tab" type="button" role="tab" aria-selected="false" aria-controls="heat-view">手续费排行</button></nav>
<section id="opportunity-view" class="tab-panel" role="tabpanel" aria-labelledby="tab-opportunity"><section class="ranking" aria-label="RWA / USDC LP 决策排名" role="table"><div class="table-header" role="row"><div role="columnheader">排名</div><div role="columnheader">Pair + Fee Tier</div><div role="columnheader">24H Volume</div><div role="columnheader">24H LP Fee</div><div role="columnheader">TVL</div><div role="columnheader">手续费率</div><div role="columnheader">预计 $1,000 日净收益</div><div role="columnheader">建议</div></div><div id="ranking-list" class="ranking-list" aria-live="polite"></div><div id="empty-state" class="empty-state" hidden></div></section>
<section class="diagnostics-section" aria-label="更多详情"><details id="verification-panel" class="verification-panel"><summary>更多详情</summary><div id="verification-list" class="verification-list"></div></details></section></section>
<section id="heat-view" class="tab-panel" role="tabpanel" aria-labelledby="tab-heat" hidden><section class="heat-ranking" aria-label="手续费热度排名" role="table"><div class="heat-header" role="row"><div role="columnheader">排名</div><div role="columnheader">Pair + Fee Tier</div><div role="columnheader">24H Volume</div><div role="columnheader">24H LP Fee</div><div role="columnheader">TVL</div><div role="columnheader">Fee Tier</div></div><div id="heat-list" class="heat-list" aria-live="polite"></div><div id="heat-empty" class="empty-state" hidden></div></section></section>
<aside id="why-drawer" class="why-drawer" aria-label="池详情" hidden></aside>
<footer>数据源：Raydium 官方 RWA / USDC 市场数据 · <span id="observed-wrap"${initialTimestamp ? "" : " hidden"}>读取：<span id="observed-at">${escapeHtml(initialTimestamp ?? "")}</span></span><a href="https://github.com/fengxiong111/lp-decision-os">查看源码</a></footer></main><script type="module" src="./runtime.js${runtimeSrc}"></script></body></html>`;
}

export { renderStyles };
