/** A deterministic synthetic rush: seeded, no customer names, built from any catalog. */

import type { Catalog } from "../../src/core/config.ts";
import type { LineRequest } from "../../src/core/orders.ts";
import type { PaymentMethod } from "../../src/core/payments.ts";

export interface RushOrder {
  at: number;
  lines: LineRequest[];
  payment: PaymentMethod;
}

export interface Rush {
  seed: number;
  start: number;
  durationMs: number;
  orders: RushOrder[];
}

export interface RushOptions {
  seed: number;
  start: number;
  durationMs: number;
  count: number;
  /** Categories ordered this many times more often than the rest (a business's best sellers). */
  favourites?: { categoryIds: string[]; weight: number };
}

/** mulberry32: small, fast and identical on every platform. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateRush(catalog: Catalog, opts: RushOptions): Rush {
  const rand = prng(opts.seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const pool = catalog.categories.flatMap((c) => {
    const weight = opts.favourites?.categoryIds.includes(c.id) ? opts.favourites.weight : 1;
    const items = c.items.filter((i) => i.available !== false);
    return Array.from({ length: weight }, () => items).flat();
  });
  if (pool.length === 0) throw new Error("generateRush: expected a catalog with available items, found none");

  const times = Array.from(
    { length: opts.count },
    () => opts.start + Math.floor(rand() * (opts.durationMs / 1000)) * 1000,
  );
  times.sort((a, b) => a - b);

  return {
    seed: opts.seed,
    start: opts.start,
    durationMs: opts.durationMs,
    orders: times.map((at) => {
      const lineCount = 1 + Math.floor(rand() * 3);
      const lines: LineRequest[] = [];
      for (let i = 0; i < lineCount; i++) {
        const item = pick(pool);
        const qty = 1 + Math.floor(rand() * 3);
        lines.push(item.variants ? { itemId: item.id, size: pick(item.variants).size, qty } : { itemId: item.id, qty });
      }
      return { at, lines, payment: rand() < 0.7 ? "upi" : "cash" };
    }),
  };
}

/** The options that produced each `samples/<name>/rush.json`; regenerate with `node scripts/gen-rush.ts <name>`. */
export const SAMPLE_RUSHES: Readonly<Record<string, RushOptions>> = {
  // 300 orders from 17:00 to 19:00 IST.
  "tea-house": {
    seed: 20261126,
    start: Date.UTC(2026, 10, 26, 11, 30),
    durationMs: 2 * 60 * 60_000,
    count: 300,
    favourites: { categoryIds: ["tea-coffee"], weight: 8 },
  },
  // 80 orders over a 90-minute morning, 08:00 in New York (UTC-5 in November).
  "coffee-cart": {
    seed: 20261127,
    start: Date.UTC(2026, 10, 27, 13, 0),
    durationMs: 90 * 60_000,
    count: 80,
    favourites: { categoryIds: ["coffee"], weight: 4 },
  },
  // 120 orders over a two-hour dinner, 19:00 IST.
  "food-truck": {
    seed: 20261128,
    start: Date.UTC(2026, 10, 28, 13, 30),
    durationMs: 2 * 60 * 60_000,
    count: 120,
  },
  // 60 orders over a morning, 07:00 IST.
  bakery: {
    seed: 20261129,
    start: Date.UTC(2026, 10, 29, 1, 30),
    durationMs: 3 * 60 * 60_000,
    count: 60,
    favourites: { categoryIds: ["breads"], weight: 2 },
  },
  // 60 tickets over a working day, 10:00 in Dubai (UTC+4).
  "service-desk": {
    seed: 20261130,
    start: Date.UTC(2026, 10, 30, 6, 0),
    durationMs: 8 * 60 * 60_000,
    count: 60,
    favourites: { categoryIds: ["quick-services"], weight: 2 },
  },
};
