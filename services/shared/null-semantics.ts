/**
 * Project-wide data contract:
 *
 * - `0` is a measured zero.
 * - `null` is the only representation of a missing/unknown value.
 * - undefined, non-finite numbers and presentation placeholders never cross an API boundary.
 */
export function isNullPlaceholder(value: unknown): boolean {
  return typeof value === "string" && ["", "-", "—", "–"].includes(value.trim());
}

export function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function sanitizeNullSemantics<T>(value: T): T {
  return sanitize(value) as T;
}

function sanitize(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (isNullPlaceholder(value)) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
  }
  return value;
}

export function jsonWithNullSemantics<T>(value: T, init?: ResponseInit): Response {
  return Response.json(sanitizeNullSemantics(value), init);
}
