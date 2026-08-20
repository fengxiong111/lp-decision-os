export async function fetchRaydiumPools(config, fetchImpl = fetch) {
  const response = await fetchImpl(config.apiUrl, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Raydium API failed: ${response.status}`);
  const payload = await response.json();
  const pools = Array.isArray(payload?.data?.data) ? payload.data.data : [];
  if (pools.length === 0) throw new Error("Raydium API returned no pools");
  return pools;
}
