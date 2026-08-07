import { z } from "zod";

export const MetricStatusSchema = z.enum(["READY", "BACKFILLING", "STALE", "UNAVAILABLE", "UNSUPPORTED"]);
export type MetricStatus = z.infer<typeof MetricStatusSchema>;

export const MetricValueSchema = z.object({
  value: z.number().finite().nullable(),
  status: MetricStatusSchema,
  reason: z.string().nullable(),
  asOf: z.string().datetime({ offset: true }).nullable(),
  coverage: z.number().finite().min(0).max(1).nullable(),
});
export type MetricValue = z.infer<typeof MetricValueSchema>;

export const RankingQuerySchema = z.object({
  capital: z.enum(["1000", "10000"]).default("1000"),
  window: z.enum(["1h", "6h", "12h", "24h"]).default("24h"),
  includeOfficialOnly: z.enum(["0", "1", "true", "false"]).default("0").transform((value) => value === "1" || value === "true"),
});

export const WalletRequestSchema = z.object({
  address: z.string().trim().max(64).nullable().optional(),
}).strict();

export const MarketProjectionEnvelopeSchema = z.object({
  projectionVersion: z.number().int().nonnegative(),
  source: z.literal("market-projection"),
  sourceTimestamp: z.string().datetime({ offset: true }),
  receivedAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  snapshot: z.record(z.string(), z.unknown()),
  rankings: z.record(z.string(), z.record(z.string(), z.unknown())),
  sourceHealth: z.record(z.string(), z.unknown()),
});
export type MarketProjectionEnvelope = z.infer<typeof MarketProjectionEnvelopeSchema>;

export const ProjectionEventSchema = z.object({
  event: z.enum(["market.snapshot", "pool.updated", "metric.updated", "ranking.updated", "backfill.updated", "health.updated", "switch.signal", "wallet.updated"]),
  projectionVersion: z.number().int().nonnegative(),
  payload: z.unknown(),
});
export type ProjectionEvent = z.infer<typeof ProjectionEventSchema>;

/** API boundary normalizer: zero stays zero; only null represents missing data. */
export function normalizeNullSemantics<T>(input: T): T {
  const visit = (value: unknown): unknown => {
    if (value === undefined || value === null) return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string" && ["", "-", "—", "–"].includes(value.trim())) return null;
    if (Array.isArray(value)) return value.map(visit);
    if (typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, visit(item)]));
    return value;
  };
  return visit(input) as T;
}
