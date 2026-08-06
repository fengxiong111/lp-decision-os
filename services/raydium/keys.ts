import type { SourceRef } from "@/packages/models/src";
import { getJson, mapWithConcurrency } from "@/services/shared/http";
import { RAYDIUM_API_BASE } from "@/services/raydium/config";

export type RaydiumPoolKeys = {
  id: string;
  vaultA: string | null;
  vaultB: string | null;
  observationId: string | null;
  exBitmapAccount: string | null;
  configId: string | null;
};

export type TickLine = {
  price: number;
  liquidity: number;
  tick: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const stringValue = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const numberValue = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

function source(label: string, url: string, observedAt: string): SourceRef {
  return { label, url, observedAt, status: "live" };
}

function parseKeys(value: unknown): RaydiumPoolKeys | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  const vault = isRecord(value.vault) ? value.vault : {};
  const config = isRecord(value.config) ? value.config : {};
  if (!id) return null;
  return {
    id,
    vaultA: stringValue(vault.A),
    vaultB: stringValue(vault.B),
    observationId: stringValue(value.observationId),
    exBitmapAccount: stringValue(value.exBitmapAccount),
    configId: stringValue(config.id),
  };
}

export async function fetchPoolKeys(ids: string[]): Promise<{ keys: Map<string, RaydiumPoolKeys>; source: SourceRef; error: string | null }> {
  const observedAt = new Date().toISOString();
  const sourceUrl = `${RAYDIUM_API_BASE}/pools/key/ids`;
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += 80) chunks.push(ids.slice(index, index + 80));
  const responses = await mapWithConcurrency(chunks, 3, async (chunk) =>
    getJson<unknown>(`${sourceUrl}?ids=${chunk.join(",")}`, 10_000),
  );
  const keys = new Map<string, RaydiumPoolKeys>();
  const errors: string[] = [];
  for (const response of responses) {
    if (response.meta.error) errors.push(response.meta.error);
    const rows = isRecord(response.data) && Array.isArray(response.data.data) ? response.data.data : [];
    for (const row of rows) {
      const parsed = parseKeys(row);
      if (parsed) keys.set(parsed.id, parsed);
    }
  }
  return {
    keys,
    source: source("Raydium Pool Keys", sourceUrl, observedAt),
    error: errors.length > 0 ? errors[0] : null,
  };
}

export async function fetchTickLine(id: string): Promise<{ line: TickLine[]; source: SourceRef; error: string | null }> {
  const observedAt = new Date().toISOString();
  const url = `${RAYDIUM_API_BASE}/pools/line/position?id=${encodeURIComponent(id)}`;
  const response = await getJson<unknown>(url, 10_000);
  const rows = isRecord(response.data) && isRecord(response.data.data) && Array.isArray(response.data.data.line)
    ? response.data.data.line
    : [];
  const line = rows.flatMap((row) => {
    if (!isRecord(row)) return [];
    const price = numberValue(row.price);
    const liquidity = numberValue(row.liquidity);
    const tick = numberValue(row.tick);
    return price === null || liquidity === null || tick === null ? [] : [{ price, liquidity, tick }];
  });
  return {
    line,
    source: source("Raydium CLMM Tick 线", url, observedAt),
    error: response.meta.error,
  };
}

export async function fetchLiquidityLine(id: string): Promise<{ source: SourceRef; error: string | null }> {
  const observedAt = new Date().toISOString();
  const url = `${RAYDIUM_API_BASE}/pools/line/liquidity?id=${encodeURIComponent(id)}`;
  const response = await getJson<unknown>(url, 10_000);
  return { source: source("Raydium 流动性历史", url, observedAt), error: response.meta.error };
}

