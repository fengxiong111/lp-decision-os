export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

export function money(value, digits = 2) {
  return value === null ? "等待数据" : `$${value.toLocaleString("en-US", { maximumFractionDigits: digits })}`;
}

export function price(value) {
  return value === null ? "等待数据" : `$${value.toLocaleString("en-US", { minimumFractionDigits: value < 1 ? 4 : 2, maximumFractionDigits: value < 1 ? 6 : 4 })}`;
}

export function formatPercent(value) {
  return value === null ? "费率等待数据" : `${(value * 100).toFixed(value < 0.01 ? 2 : 3)}%`;
}

export function capacityNote(pool, capital) {
  const share = capital / (pool.tvl + capital);
  if (share >= 0.5) return "投入接近池规模";
  if (share >= 0.2) return "投入占比较高";
  return "容量可承接";
}

export function formatTimestamp(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf()) || date.getTime() < Date.UTC(2020, 0, 1) || date.getTime() > Date.now() + 5 * 60 * 1000) return null;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date).replaceAll("/", "-");
}
