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

function rankingRows(rows) {
  return rows.slice(0, 20).map((row, index) => `
    <article class="ranking-row">
      <span class="rank">${String(index + 1).padStart(2, "0")}</span>
      <span class="asset"><strong>${escapeHtml(row.symbol)}/USDC</strong><small>${escapeHtml(row.name)}</small></span>
      <span class="metric volume"><small>24h 成交量</small><strong>${money(row.volume24h, 0)}</strong></span>
      <span class="metric fee"><small>24h LP Fee</small><strong>${money(row.lpFee24h, 2)}</strong></span>
      <span class="metric tvl"><small>TVL</small><strong>${money(row.tvl, 0)}</strong></span>
      <span class="estimate"><small>预计手续费</small><strong>${money(row.estimatedFee, 4)}</strong></span>
      <a class="pool" href="https://raydium.io/liquidity-pools/?id=${encodeURIComponent(row.poolAddress)}"><small>Pool</small><strong>${shortAddress(row.poolAddress)}</strong></a>
    </article>`).join("");
}

function html(rankings, updatedAt) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="300">
<title>Raydium RWA LP 移动看板</title><style>
:root{--paper:#f5f4ed;--ink:#141413;--muted:#6b6a64;--line:#dedbd0;--blue:#1b365d}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}main{max-width:1240px;margin:auto;padding:34px 28px 60px}.ranking{border-top:1px solid var(--line)}.ranking-row{display:grid;grid-template-columns:52px minmax(180px,1.3fr) repeat(3,minmax(120px,.8fr)) minmax(145px,.9fr) 120px;gap:16px;align-items:center;padding:22px 10px;border-bottom:1px solid var(--line)}.rank{color:var(--blue);font:500 19px/1 Georgia,serif}.asset,.metric,.estimate,.pool{display:grid;gap:5px;min-width:0}.asset strong,.estimate strong{font-family:"Iowan Old Style","Songti SC",STSong,Georgia,serif;font-weight:500}.asset strong{font-size:22px}.asset small,.metric small,.estimate small,.pool small{overflow:hidden;color:var(--muted);font-size:12px;text-overflow:ellipsis;white-space:nowrap}.metric strong,.pool strong{overflow:hidden;color:var(--ink);font-size:15px;font-weight:500;text-overflow:ellipsis;white-space:nowrap}.estimate strong{color:var(--blue);font-size:24px;font-variant-numeric:tabular-nums}.pool{text-decoration:none}.pool:hover strong{text-decoration:underline}footer{margin-top:42px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:12px;line-height:1.7}footer a{color:var(--blue)}@media(max-width:960px){main{padding:26px 22px 50px}.ranking-row{grid-template-columns:42px minmax(160px,1.2fr) repeat(2,minmax(105px,.8fr)) 140px}.volume,.pool{display:none}}@media(max-width:680px){main{padding:20px 16px 40px}.ranking-row{grid-template-columns:34px minmax(0,1fr) 120px;gap:10px;padding:19px 2px}.metric,.pool{display:none}.rank{font-size:17px}.asset strong{font-size:20px}.asset small,.estimate small{font-size:11px}.estimate{text-align:right}.estimate strong{font-size:21px}footer{font-size:11px}}
</style></head><body><main>
<section class="ranking">${rankingRows(rankings.get(1_000))}</section>
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
