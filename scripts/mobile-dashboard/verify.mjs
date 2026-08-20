function fail(message) {
  throw new Error(`GitHub 外版验收失败：${message}`);
}

const FORBIDDEN_POSITION_FIELDS = /^(walletAddress|walletBalance|positionNft|tokenFeesOwed|personalPosition|positionState)$/i;
const LEGACY_PRESENTATION_TEXT = ["24h 成交量", "24h LP Fee", "预计手续费"];
const DISPLAY_ACTIONS = new Set(["OPEN_READY", "WATCH", "REVIEW", "BLOCKED"]);
const OPPORTUNITY_STATUSES = new Set(["READY", "WATCH", "BLOCKED"]);

function containsForbiddenPositionField(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some(containsForbiddenPositionField);
  if (typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => FORBIDDEN_POSITION_FIELDS.test(key) || containsForbiddenPositionField(child));
}

export function verifyMarketData(pools, optimizerSummary, config) {
  if (pools.length === 0) fail("没有标准化 Pool");
  if (config.capital !== 1_000) fail("主资金规模不是固定 $1,000");
  if (config.autoExecution !== false) fail("自动执行边界不是 OFF");
  if (optimizerSummary.top3.length > 3) fail("页面 Top 3 超过 3 个结果");
  if (optimizerSummary.results.some(({ pool, optimizer }) => containsForbiddenPositionField({ pool, optimizer }))) {
    fail("外版数据包含真实钱包或真实仓位字段");
  }

  for (const pool of pools) {
    for (const field of ["assetMint", "symbol", "poolAddress", "poolType", "quoteMint"]) {
      if (!pool[field]) fail(`Pool 缺少 ${field}`);
    }
    for (const field of ["tvl", "volume24h", "lpFee24h"]) {
      if (!Number.isFinite(pool[field])) fail(`Pool ${pool.symbol} 的 ${field} 不是有限数字`);
    }
    if (pool.quoteMint !== config.usdcMint || pool.usdcIdentityVerified !== true) fail(`Pool ${pool.symbol} 不是已证明的 USDC 报价`);
  }

  const executable = optimizerSummary.results.filter(({ optimizer }) => optimizer.executable);
  if (executable.some(({ optimizer }) => !optimizer.best || !Number.isFinite(optimizer.best.expectedNetFee24h))) {
    fail("可执行结果缺少有限的 EXPECTED_NET_FEE_24H_USD_1000");
  }
  if (optimizerSummary.top3.some((row, index) => row.rank !== index + 1)) fail("Top 3 rank 不连续");
  if (optimizerSummary.top3.some((row, index, rows) => index > 0 && rows[index - 1].best.expectedNetFee24h < row.best.expectedNetFee24h)) {
    fail("Top 3 未按 EXPECTED_NET_FEE_24H_USD_1000 降序");
  }
  if (new Set(optimizerSummary.top3.map((row) => row.poolAddress)).size !== optimizerSummary.top3.length) fail("Top 3 出现重复 Pool");
  if (optimizerSummary.top3.some((row) => !["OPEN", "HOLD", "MOVE_CORE", "MOVE_BOTH", "CLOSE", "UNAVAILABLE"].includes(row.action))) {
    fail("Top 3 出现未允许的 Action");
  }
}

export function verifyPageMarkup(markup) {
  const headerCells = markup.match(/role="columnheader"/g) ?? [];
  if (headerCells.length !== 7) fail(`表头列数为 ${headerCells.length}，应为 7`);
  if (!markup.includes("RWA / USDC LP Optimizer")) fail("缺少 Optimizer 页面标题");
  if (!markup.includes("只保留 Top 3")) fail("页面没有声明 Top 3 范围");
  if (!/<script type="module" src="\.\/runtime\.js(?:\?[^\"]+)?"><\/script>/.test(markup)) fail("缺少独立浏览器运行时");
  if (!markup.includes('data-top3-source="./top3.json"')) fail("页面没有声明唯一 top3.json 数据源");
  if (!markup.includes("Opportunity Score") || !markup.includes("Net Estimate") || !markup.includes("Core") || !markup.includes("Buffer") || !markup.includes("Confidence") || !markup.includes("Action")) fail("页面缺少机会层主表字段");
  if (!markup.includes("WHY") || !markup.includes("正在验证")) fail("页面缺少可解释性诊断入口");
  if (LEGACY_PRESENTATION_TEXT.some((label) => markup.includes(label))) fail("页面仍包含旧版字段");
  if (markup.includes('class="optimizer-row"')) fail("页面在静态 HTML 中嵌入了旧排名行");
  if (/<(?:span|br|strong)\b/i.test(markup.match(/<script type="module"[^>]*>[\s\S]*?<\/script>/)?.[0] ?? "")) fail("运行时脚本不应包含展示 HTML");
  if (markup.includes("资金档") || markup.includes("MIGRATE") || markup.includes("连接钱包") || markup.includes("serviceWorker")) fail("页面仍包含已删除的资金档、动作语义或缓存脚本");
}

export function verifyDataJson(dataJson) {
  if (/<\/?(?:span|br|strong|div)\b/i.test(dataJson)) fail("data.json 含有展示标记");
  if (FORBIDDEN_POSITION_FIELDS.test(dataJson)) fail("data.json 含有真实钱包或真实仓位字段");
}

export function verifySnapshot(snapshot, config) {
  if (snapshot?.schemaVersion !== 1) fail("证据快照 schemaVersion 不正确");
  if (!snapshot?.generatedAt || !snapshot?.snapshotHash || !/^[a-f0-9]{64}$/.test(snapshot.snapshotHash)) fail("证据快照缺少有效 snapshotHash");
  if (snapshot.scope?.capital !== 1_000 || config.capital !== 1_000) fail("快照资金规模不是固定 $1,000");
  if (snapshot.scope?.autoExecution !== false || config.autoExecution !== false) fail("快照自动执行边界不是 OFF");
  if (!snapshot.sourceEvidence?.api || !snapshot.sourceEvidence?.rpc || !snapshot.sourceEvidence?.evidenceSummary) fail("快照缺少来源证据摘要");
  if (!Array.isArray(snapshot.top3) || snapshot.top3.length > 3) fail("快照 Top 3 数量非法");
  if (snapshot.publicPoolCount > 0 && snapshot.top3.length === 0) fail("存在公开 Pool 时机会层不得为空");
  if (snapshot.top3.some((row, index) => row.rank !== index + 1 || !OPPORTUNITY_STATUSES.has(row.opportunityStatus) || !Array.isArray(row.evidence) || !row.poolAddress || typeof row.pair !== "string" || !DISPLAY_ACTIONS.has(row.action))) fail("Top 3 缺少 Opportunity 结果");
  if (snapshot.top3.some((row) => !Number.isFinite(row.opportunityScore) || !Number.isFinite(row.confidence) || [row.netEstimate, row.coreCapital, row.coreLower, row.coreUpper, row.bufferCapital, row.bufferLower, row.bufferUpper].some((value) => value !== null && !Number.isFinite(value)))) fail("Top 3 缺少有效 Opportunity / Confidence 或 Core / Buffer 字段");
  if (!snapshot.opportunityRanking || snapshot.opportunityRanking.version !== 1 || !Number.isInteger(snapshot.opportunityRanking.candidateCount)) fail("快照缺少 Opportunity Ranking 摘要");
  if (!snapshot.diagnostics || snapshot.diagnostics.version !== 1 || !Array.isArray(snapshot.diagnostics.matrix)) fail("快照缺少 READY / NEAR_READY / BLOCKED 诊断矩阵");
  if (snapshot.diagnostics.matrix.some((row) => !row.poolAddress || !row.pair || !["READY", "NEAR_READY", "BLOCKED"].includes(row.status) || !Array.isArray(row.evidence))) fail("诊断矩阵包含非法状态或证据项");
  if (containsForbiddenPositionField(snapshot)) fail("证据快照包含真实钱包或真实仓位字段");
}
