import { mkdir, writeFile } from "node:fs/promises";

const API_URL = "https://api-v3.raydium.io/pools/info/list-v2?size=1000&hasReward=false&sortField=liquidity&sortType=desc&mintFilter=RWA";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OUTPUT_DIR = new URL("../mobile-dashboard/", import.meta.url);
const CAPITALS = [1_000];

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
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="300">
<title>Raydium RWA LP 移动看板</title><style>
:root{--paper:#f5f4ed;--ivory:#faf9f5;--ink:#141413;--muted:#6b6a64;--line:#dedbd0;--blue:#1b365d}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}main{max-width:980px;margin:auto;padding:52px 16px 64px}.overline{color:var(--blue);font-size:11px;font-weight:600;letter-spacing:.15em}.hero{padding-bottom:40px;border-bottom:1px solid var(--line)}h1,h2,.asset strong,.score strong{font-family:"Iowan Old Style","Songti SC",STSong,Georgia,serif;font-weight:500}.hero h1{max-width:760px;margin:20px 0 0;font-size:clamp(42px,8vw,72px);line-height:1.07;letter-spacing:-.045em}.hero p{max-width:650px;margin:22px 0 0;color:var(--muted);line-height:1.75}.section{padding-top:40px}.section h2{margin:8px 0 18px;font-size:29px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:13px}.card{padding:20px;border:1px solid var(--line);border-radius:16px;background:var(--ivory);box-shadow:0 4px 24px rgba(20,20,19,.04)}.rank{color:var(--blue);font:500 17px/1 Georgia,serif}.asset,.score{display:grid;gap:4px;margin-top:16px}.asset strong{font-size:23px}.asset span,.score span{color:var(--muted);font-size:10px}.score{padding-top:14px;border-top:1px solid var(--line)}.score strong{color:var(--blue);font-size:29px}dl{margin:12px 0 0}dl div{display:flex;justify-content:space-between;margin-top:6px;font-size:11px}dt{color:var(--muted)}dd{margin:0}a{color:var(--blue)}.table-wrap{overflow:auto;border-top:1px solid var(--line)}table{border-collapse:collapse;width:100%;min-width:700px}th,td{text-align:right;padding:13px 9px;border-bottom:1px solid var(--line);font-size:11px}th{color:var(--muted)}th:nth-child(2),td:nth-child(2){text-align:left}td small{display:block;color:var(--muted)}footer{margin-top:34px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:10px;line-height:1.7}@media(max-width:760px){main{padding-top:42px}.cards{grid-template-columns:1fr}.card{padding:18px}.hero h1{font-size:43px}.table-wrap{margin-left:-16px;margin-right:-16px;padding-left:16px}}
</style></head><body><main>
<header class="hero"><span class="overline">RWA LIQUIDITY NOTE · 1,000U</span><h1>今天，流动性把机会放在哪里？</h1><p>基于 Raydium RWA/USDC 官方 24 小时数据，按 1,000U 投入后的预计手续费收入排序。数字是决策的起点，不是收益承诺。</p></header>
<section class="section"><span class="overline">00 · TOP THREE</span><h2>优先查看</h2><div class="cards">${rankingCards(rankings.get(1_000))}</div></section>
<section class="section"><span class="overline">01 · FULL RANKING</span><h2>1,000U 手续费排名</h2><div class="table-wrap"><table><thead><tr><th>#</th><th>资产</th><th>预估手续费</th><th>TVL</th><th>24h 成交量</th><th>24h LP Fee</th></tr></thead><tbody>${tableRows(rankings.get(1_000))}</tbody></table></div></section>
<footer>每 15 分钟刷新 Raydium 官方 24h 数据。预估公式：24h LP Fee × 1,000 / (TVL + 1,000)。未扣除无常损失、进出滑点与再平衡成本。数据生成：${escapeHtml(updatedAt)} · <a href="https://github.com/fengxiong111/lp-decision-os">查看源码</a></footer></main></body></html>`;
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
