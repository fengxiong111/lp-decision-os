function renderStyles() {
  return `
:root {
  --paper: #f6f5ef;
  --surface: rgba(255, 255, 255, .72);
  --ink: #181817;
  --muted: #74726d;
  --soft: #9a9891;
  --line: #e2e0d8;
  --accent: #7257a8;
  --content: 1180px;
  --pool-columns: 42px minmax(260px, 2fr) minmax(126px, .9fr) minmax(126px, .9fr) minmax(150px, 1fr) minmax(150px, 1fr);
}
* { box-sizing: border-box; }
html { min-height: 100%; background: var(--paper); }
body {
  min-height: 100%;
  margin: 0;
  overflow-x: hidden;
  background: var(--paper);
  color: var(--ink);
  font: 15px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif;
  font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased;
}
main { width: min(calc(100% - 48px), var(--content)); margin: 0 auto; padding: 54px 0 64px; }
.radar-header { display: flex; align-items: baseline; justify-content: space-between; gap: 20px; padding: 0 2px 22px; border-bottom: 1px solid var(--line); }
.radar-header h1 { margin: 0; font-size: 28px; font-weight: 760; letter-spacing: -.055em; }
.radar-status { color: var(--muted); font-size: 12px; white-space: nowrap; }
.pool-table { width: 100%; }
.pool-table-head, .pool-grid { display: grid; grid-template-columns: var(--pool-columns); column-gap: 12px; align-items: center; }
.pool-table-head { padding: 13px 12px 11px; border-bottom: 1px solid var(--line); color: var(--soft); font-size: 10px; font-weight: 650; letter-spacing: .04em; }
.pool-table-head > div:nth-child(-n+3) { text-align: left; }
.pool-table-head > div:nth-child(n+4) { text-align: right; }
.pool-row { padding: 20px 12px; border-bottom: 1px solid rgba(226, 224, 216, .78); }
.pool-row:hover { background: rgba(255, 255, 255, .42); }
.pool-rank { color: var(--soft); font-size: 12px; }
.pool-identity, .pool-venue { min-width: 0; text-align: left; }
.pool-identity strong { display: block; overflow: hidden; font-size: 18px; font-weight: 740; letter-spacing: -.04em; line-height: 1.12; text-overflow: ellipsis; white-space: nowrap; }
.pool-venue strong { display: block; font-size: 14px; font-weight: 680; }
.pool-metric { min-width: 0; text-align: right; }
.pool-metric strong { display: block; overflow: hidden; font-size: 15px; font-weight: 680; white-space: nowrap; text-overflow: ellipsis; }
.pool-fee strong { color: var(--ink); font-size: 17px; font-weight: 750; }
.empty-state { padding: 54px 16px; border: 1px dashed var(--line); border-radius: 14px; color: var(--muted); text-align: center; }
.empty-state strong { display: block; color: var(--ink); font-size: 18px; }
.empty-state span { display: block; margin-top: 6px; font-size: 12px; }
#detail-drawer { position: fixed; inset: 0; z-index: 8; }
.drawer-backdrop { position: fixed; inset: 0; z-index: 9; background: rgba(20, 20, 18, .14); }
.drawer-panel { position: fixed; inset: 0 0 0 auto; z-index: 10; width: min(560px, 100%); padding: 26px 26px 38px; overflow-y: auto; background: #fbfaf5; box-shadow: -16px 0 44px rgba(24, 24, 21, .12); }
.drawer-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding-bottom: 18px; border-bottom: 1px solid var(--line); }
.drawer-kicker { margin-bottom: 7px; color: var(--accent); font-size: 10px; font-weight: 750; letter-spacing: .06em; text-transform: uppercase; }
.drawer-header h2 { margin: 0; font-size: 24px; font-weight: 760; letter-spacing: -.05em; }
.drawer-meta { margin-top: 6px; color: var(--muted); font-size: 12px; }
.drawer-close { width: 30px; height: 30px; border: 0; border-radius: 9px; background: transparent; color: var(--muted); cursor: pointer; font-size: 22px; line-height: 1; }
.drawer-close:hover { background: rgba(0, 0, 0, .045); color: var(--ink); }
.drawer-section { margin-top: 24px; }
.drawer-section h3 { margin: 0 0 11px; font-size: 13px; font-weight: 720; letter-spacing: -.01em; }
.drawer-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
.drawer-card { min-height: 60px; padding: 11px 12px; border: 1px solid var(--line); border-radius: 12px; background: rgba(255, 255, 255, .54); }
.drawer-card small { display: block; color: var(--muted); font-size: 10px; }
.drawer-card strong { display: block; margin-top: 4px; font-size: 14px; font-weight: 680; }
.decision-list { display: grid; gap: 8px; color: var(--muted); font-size: 12px; }
.decision-list div { padding-left: 12px; border-left: 2px solid var(--line); }
.decision-list .positive { border-color: #aac4b2; color: #4d6e59; }
.decision-list .attention { border-color: #d4b992; color: #84623a; }
.advanced { border-top: 1px solid var(--line); padding-top: 14px; }
.advanced summary { cursor: pointer; color: var(--muted); font-size: 12px; font-weight: 700; }
.advanced .drawer-grid { margin-top: 11px; }
.copy-pool { margin-top: 16px; padding: 9px 13px; border: 1px solid var(--line); border-radius: 999px; background: transparent; color: var(--muted); cursor: pointer; font-size: 12px; font-weight: 680; }
.copy-pool:hover, .copy-pool[data-state="copied"] { border-color: var(--accent); color: var(--accent); }
[hidden] { display: none !important; }
@media (max-width: 1100px) {
  :root { --pool-columns: 32px minmax(180px, 1.65fr) minmax(100px, .85fr) minmax(96px, .85fr) minmax(118px, 1fr) minmax(124px, 1fr); }
  main { width: min(calc(100% - 32px), var(--content)); padding-top: 36px; }
  .pool-table-head, .pool-grid { column-gap: 8px; }
  .pool-table-head { padding-left: 8px; padding-right: 8px; }
  .pool-row { padding: 17px 8px; }
}
@media (max-width: 720px) {
  main { width: calc(100% - 24px); padding-top: 24px; }
  .radar-header { display: block; padding-bottom: 17px; }
  .radar-header h1 { font-size: 25px; }
  .radar-status { display: block; margin-top: 7px; }
  .pool-table-head { display: none; }
  .pool-row { padding: 17px 4px; }
  .pool-grid { grid-template-columns: minmax(0, 1fr) minmax(120px, auto); grid-template-areas: "rank rank" "identity venue" "tvl volume" "fee fee"; gap: 11px 18px; }
  .pool-rank { grid-area: rank; }
  .pool-identity { grid-area: identity; }
  .pool-venue { grid-area: venue; text-align: right; }
  .pool-tvl { grid-area: tvl; text-align: left; }
  .pool-volume { grid-area: volume; }
  .pool-fee { grid-area: fee; text-align: left; }
  .pool-metric::before { display: block; margin-bottom: 2px; color: var(--soft); font-size: 10px; }
  .pool-tvl::before { content: "TVL"; }
  .pool-volume::before { content: "Volume"; }
  .pool-fee::before { content: "Fee"; }
  .pool-identity strong { font-size: 18px; }
  .pool-venue strong { font-size: 13px; }
  .drawer-panel { padding: 22px 17px 32px; }
}
@media (max-width: 420px) {
  .drawer-grid { grid-template-columns: 1fr; }
}
`;
}

export function renderPage({ snapshotHash = null, runtimeVersion = null }) {
  const runtimeQuery = runtimeVersion ?? snapshotHash;
  const runtimeSrc = runtimeQuery ? `?v=${encodeURIComponent(runtimeQuery.slice(0, 12))}` : "";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#f6f5ef"><meta name="data-source" content="./top3.json"><title>LP Fee Ranking · Solana</title><style>${renderStyles()}</style></head><body><main data-top3-source="./top3.json">
<header class="radar-header"><h1>LP Fee Ranking</h1><span id="market-status" class="radar-status">官方 API · 24H LP Fee DESC</span></header><section class="pool-table" role="table" aria-label="LP Fee Ranking"><div class="pool-table-head" role="row"><div role="columnheader">#</div><div role="columnheader">池</div><div role="columnheader">DEX</div><div role="columnheader">TVL</div><div role="columnheader">Volume</div><div role="columnheader">Fee</div></div><div id="pool-list" aria-live="polite"></div><div id="empty-state" class="empty-state" hidden></div></section>
<aside id="detail-drawer" hidden></aside>
</main><script type="module" src="./runtime.js${runtimeSrc}"></script></body></html>`;
}

export { renderStyles };
