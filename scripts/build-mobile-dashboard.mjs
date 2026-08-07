import { mkdir, writeFile } from "node:fs/promises";

const API_URL = "https://api-v3.raydium.io/pools/info/list-v2?size=1000&hasReward=false&sortField=liquidity&sortType=desc&mintFilter=RWA";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OUTPUT_DIR = new URL("../mobile-dashboard/", import.meta.url);
const CAPITALS = [1_000, 10_000];

const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const money = (value, digits = 2) => value === null ? "等待数据" : `$${value.toLocaleString("en-US", { maximumFractionDigits: digits })}`;
const shortAddress = (value) => `${value.slice(0, 5)}…${value.slice(-5)}`;

function normalizePool(pool) {
  if (!Array.isArray(pool.pooltype) || !pool.pooltype.includes("RWA")) return null;
  const mintA = pool.mintA ?? {};
  const mintB = pool.mintB ?? {};
  const asset = mintA.address === USDC_MINT ? mintB : mintB.address === USDC_MINT ? mintA : null;
  if (!asset?.address) return null;
  const tvl = number(pool.tvl);
  const volume24h = number(pool.day?.volume);
  const lpFee24h = number(pool.day?.volumeFee);
  if (tvl === null || volume24h === null || lpFee24h === null) return null;
  return {
    assetMint: asset.address,
    symbol: asset.symbol || asset.address.slice(0, 6),
    name: asset.name || "未命名资产",
    poolAddress: pool.id,
    poolType: Array.isArray(pool.pooltype) && pool.pooltype.includes("Clmm") ? "CLMM" : pool.type || "Pool",
    tvl,
    volume24h,
    lpFee24h,
    apr: number(pool.day?.feeApr ?? pool.day?.apr),
    feeTier: number(pool.feeRate),
  };
}

function rankPools(pools, capital) {
  const eligible = pools.filter((pool) => pool.volume24h > 1_000 && pool.lpFee24h > 30 && pool.tvl > 5_000);
  const byAsset = new Map();
  for (const pool of eligible) {
    const estimatedFee = pool.lpFee24h * capital / (pool.tvl + capital);
    const candidate = { ...pool, estimatedFee };
    const current = byAsset.get(pool.assetMint);
    if (!current || candidate.estimatedFee > current.estimatedFee) byAsset.set(pool.assetMint, candidate);
  }
  return [...byAsset.values()].sort((a, b) => b.estimatedFee - a.estimatedFee);
}

function rankingCards(rows) {
  return rows.slice(0, 3).map((row, index) => `
    <article class="card rank-${index + 1}">
      <div class="rank">0${index + 1}</div>
      <div class="asset"><strong>${escapeHtml(row.symbol)}/USDC</strong><span>${escapeHtml(row.name)}</span></div>
      <div class="score"><strong>${money(row.estimatedFee, 4)}</strong><span>预估 24h LP 手续费</span></div>
      <dl>
        <div><dt>TVL</dt><dd>${money(row.tvl, 0)}</dd></div>
        <div><dt>24h 成交量</dt><dd>${money(row.volume24h, 0)}</dd></div>
        <div><dt>24h LP Fee</dt><dd>${money(row.lpFee24h, 2)}</dd></div>
        <div><dt>Pool</dt><dd><a href="https://raydium.io/liquidity-pools/?id=${encodeURIComponent(row.poolAddress)}">${shortAddress(row.poolAddress)}</a></dd></div>
      </dl>
    </article>`).join("");
}

function tableRows(rows) {
  return rows.slice(0, 20).map((row, index) => `
    <tr>
      <td>${index + 1}</td><td><strong>${escapeHtml(row.symbol)}</strong><small>${escapeHtml(row.name)}</small></td>
      <td>${money(row.estimatedFee, 4)}</td><td>${money(row.tvl, 0)}</td><td>${money(row.volume24h, 0)}</td><td>${money(row.lpFee24h, 2)}</td>
    </tr>`).join("");
}

function html(rankings, updatedAt) {
  const payload = JSON.stringify(Object.fromEntries(CAPITALS.map((capital) => [capital, rankings.get(capital)]))).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="300">
<title>Raydium RWA LP 移动看板</title><style>
:root{color-scheme:dark;--bg:#060912;--panel:#0d1422;--line:#21304a;--text:#eef4ff;--muted:#8da0bd;--cyan:#49d7ff;--green:#66f5ae}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top right,#132847 0,transparent 34%),var(--bg);color:var(--text);font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}main{max-width:980px;margin:auto;padding:24px 14px 60px}header{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;margin-bottom:20px}h1{font-size:22px;margin:0 0 6px}.muted,small{color:var(--muted)}.status{color:var(--green);white-space:nowrap}.controls{display:flex;gap:8px;margin:16px 0}.controls button{background:#111b2c;border:1px solid var(--line);color:var(--text);padding:9px 14px;border-radius:9px}.controls button.active{border-color:var(--cyan);color:var(--cyan)}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.card{background:linear-gradient(145deg,#101a2b,#0a101c);border:1px solid var(--line);border-radius:14px;padding:16px}.rank{color:var(--cyan);font-size:22px}.asset,.score{display:flex;justify-content:space-between;gap:8px;align-items:end;margin-top:12px}.asset strong{font-size:17px}.asset span,.score span{color:var(--muted);font-size:11px;text-align:right}.score strong{color:var(--green);font-size:20px}dl{border-top:1px solid var(--line);margin:14px 0 0;padding-top:8px}dl div{display:flex;justify-content:space-between;margin-top:6px}dt{color:var(--muted)}dd{margin:0}a{color:var(--cyan)}.table-wrap{overflow:auto;margin-top:18px;border:1px solid var(--line);border-radius:12px}table{border-collapse:collapse;width:100%;min-width:700px;background:rgba(13,20,34,.85)}th,td{text-align:right;padding:10px;border-bottom:1px solid #172338}th:nth-child(2),td:nth-child(2){text-align:left}td small{display:block}.note{margin-top:18px;padding:12px;border-left:3px solid #e4aa45;background:#19150d;color:#d9c9a4}@media(max-width:760px){header{display:block}.status{display:block;margin-top:8px}.cards{grid-template-columns:1fr}.card{padding:14px}}
</style></head><body><main><header><div><h1>Raydium RWA LP 移动看板</h1><div class="muted">官方 API 24h 基线 · 默认筛选：成交量 &gt; $1,000、LP Fee &gt; $30、TVL &gt; $5,000</div></div><div class="status">● 已更新<br><small>${escapeHtml(updatedAt)}</small></div></header>
<div class="controls"><button data-capital="1000" class="active">1,000U</button><button data-capital="10000">10,000U</button></div>
<section id="cards" class="cards">${rankingCards(rankings.get(1_000))}</section>
<div class="table-wrap"><table><thead><tr><th>#</th><th>资产</th><th>预估手续费</th><th>TVL</th><th>24h 成交量</th><th>24h LP Fee</th></tr></thead><tbody id="rows">${tableRows(rankings.get(1_000))}</tbody></table></div>
<div class="note">这是每 15 分钟刷新的近实时官方 24h 排名，不是本机 SQLite 回补的 1h/6h/12h 链上短窗口。预估公式：24h LP Fee × 资金 / (TVL + 资金)。<a href="https://github.com/fengxiong111/lp-decision-os">查看源码</a></div>
<script>const rankings=${payload};const money=(v,d=2)=>'$'+v.toLocaleString('en-US',{maximumFractionDigits:d});const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));function render(capital){const data=rankings[capital];document.querySelectorAll('button').forEach(b=>b.classList.toggle('active',b.dataset.capital===String(capital)));document.querySelector('#cards').innerHTML=data.slice(0,3).map((r,i)=>'<article class="card"><div class="rank">0'+(i+1)+'</div><div class="asset"><strong>'+esc(r.symbol)+'/USDC</strong><span>'+esc(r.name)+'</span></div><div class="score"><strong>'+money(r.estimatedFee,4)+'</strong><span>预估 24h LP 手续费</span></div><dl><div><dt>TVL</dt><dd>'+money(r.tvl,0)+'</dd></div><div><dt>24h 成交量</dt><dd>'+money(r.volume24h,0)+'</dd></div><div><dt>24h LP Fee</dt><dd>'+money(r.lpFee24h)+'</dd></div></dl></article>').join('');document.querySelector('#rows').innerHTML=data.slice(0,20).map((r,i)=>'<tr><td>'+(i+1)+'</td><td><strong>'+esc(r.symbol)+'</strong><small>'+esc(r.name)+'</small></td><td>'+money(r.estimatedFee,4)+'</td><td>'+money(r.tvl,0)+'</td><td>'+money(r.volume24h,0)+'</td><td>'+money(r.lpFee24h)+'</td></tr>').join('')}document.querySelectorAll('button').forEach(b=>b.onclick=()=>render(Number(b.dataset.capital)));</script></main></body></html>`;
}

async function sendTelegram(rows, updatedAt) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log("Telegram secrets are not configured; dashboard generation continues without push.");
    return;
  }
  const lines = rows.slice(0, 3).map((row, index) => `${index + 1}. ${row.symbol}/USDC\n预估手续费 ${money(row.estimatedFee, 4)} · TVL ${money(row.tvl, 0)}\n24h Fee ${money(row.lpFee24h, 2)}`);
  const text = `Raydium RWA LP 前三名（1,000U）\n${updatedAt}\n\n${lines.join("\n\n")}\n\n看板：https://fengxiong111.github.io/lp-decision-os/`;
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!response.ok) throw new Error(`Telegram push failed: ${response.status} ${await response.text()}`);
}

const response = await fetch(API_URL, { headers: { accept: "application/json" } });
if (!response.ok) throw new Error(`Raydium API failed: ${response.status}`);
const payload = await response.json();
const pools = (payload?.data?.data ?? []).map(normalizePool).filter(Boolean);
if (pools.length === 0) throw new Error("Raydium API returned no usable RWA/USDC pools");
const rankings = new Map(CAPITALS.map((capital) => [capital, rankPools(pools, capital)]));
if (rankings.get(1_000).length < 3) throw new Error("Fewer than three pools passed the ranking filters");
const updatedAt = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "medium", hour12: false }).format(new Date());
await mkdir(OUTPUT_DIR, { recursive: true });
await writeFile(new URL("index.html", OUTPUT_DIR), html(rankings, updatedAt));
await writeFile(new URL("data.json", OUTPUT_DIR), JSON.stringify({ updatedAt, rankings: Object.fromEntries(rankings) }, null, 2));
if (process.argv.includes("--telegram")) await sendTelegram(rankings.get(1_000), updatedAt);
console.log(JSON.stringify({ updatedAt, poolCount: pools.length, top3: rankings.get(1_000).slice(0, 3).map((row) => row.symbol) }, null, 2));
