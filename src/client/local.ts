/**
 * What a customer's own phone remembers, and nothing the server ever sees: starred items and the last few orders
 * (for "Recent" and "Order again"). Pure functions over a list; the caller stores it (a kiosk stores nothing).
 */

import type { CartLine } from "./cart.ts";

export const MAX_RECENT = 10;

export interface RecentOrder {
  token: string;
  at: number;
  totalMinor: number;
  lines: (CartLine & { name: string })[];
}

/** Parses a stored JSON list; anything malformed is an empty list, never an error. */
export function parseList<T>(raw: string | undefined, ok: (v: unknown) => v is T): T[] {
  if (raw === undefined) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter(ok) : [];
  } catch {
    return [];
  }
}

export const isId = (v: unknown): v is string => typeof v === "string" && v !== "";

export function isRecent(v: unknown): v is RecentOrder {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Partial<RecentOrder>;
  return (
    typeof o.token === "string" &&
    typeof o.at === "number" &&
    typeof o.totalMinor === "number" &&
    Array.isArray(o.lines) &&
    o.lines.every((l) => typeof l?.itemId === "string" && typeof l.qty === "number" && typeof l.name === "string")
  );
}

/** Adds the item to the stars, or removes it if starred. */
export function toggleFavourite(list: readonly string[], itemId: string): string[] {
  return list.includes(itemId) ? list.filter((i) => i !== itemId) : [...list, itemId];
}

/** The newest order first, at most `MAX_RECENT`, one entry per token. */
export function addRecent(list: readonly RecentOrder[], order: RecentOrder): RecentOrder[] {
  return [order, ...list.filter((o) => o.token !== order.token)].slice(0, MAX_RECENT);
}
