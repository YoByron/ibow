/** A deterministic synthetic rush: seeded, no customer names, built from any catalog. */

import type { Catalog, CatalogItem, Category, ExtraGroup, Zone } from "../../src/core/config.ts";
import type { LineRequest } from "../../src/core/orders.ts";
import type { PaymentMethod } from "../../src/core/payments.ts";
import type { DemoEvent } from "../../src/demo/seed.ts";

export interface RushOrder {
  at: number;
  lines: LineRequest[];
  payment: PaymentMethod;
  /** Where the customer sits, as a spot id from the sample's spots.json; only for venues that have spots. */
  spot?: string;
}

export interface Rush {
  seed: number;
  start: number;
  durationMs: number;
  orders: RushOrder[];
  /** The demo's events (D-086), copied from the options: written by hand, not generated. */
  events?: DemoEvent[];
}

export interface RushOptions {
  seed: number;
  start: number;
  durationMs: number;
  count: number;
  /** Categories ordered this many times more often than the rest (a business's best sellers). */
  favourites?: { categoryIds: string[]; weight: number };
  events?: DemoEvent[];
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

const NOTES = ["less spicy", "no onion", "extra hot", "no ice", "extra napkins", "dressing on the side"];

/** The extras groups an item offers (its category's, then its own), from the catalog's library. */
function groupsOf(catalog: Catalog, category: Category, item: CatalogItem): ExtraGroup[] {
  const ids = [...new Set([...(category.extras ?? []), ...(item.extras ?? [])])];
  return ids.flatMap((id) => catalog.extras?.find((g) => g.id === id) ?? []);
}

/** With `zones` the rush's orders name where they sit; with a catalog that has extras, lines carry some and a few carry a note. */
export function generateRush(catalog: Catalog, opts: RushOptions, zones: readonly Zone[] = []): Rush {
  const rand = prng(opts.seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const pool = catalog.categories.flatMap((c) => {
    const weight = opts.favourites?.categoryIds.includes(c.id) ? opts.favourites.weight : 1;
    const items = c.items.filter((i) => i.available !== false).map((item) => ({ item, category: c }));
    return Array.from({ length: weight }, () => items).flat();
  });
  // Café orders sit at tables; rooms get their room-bill orders from the demo seed (D-086).
  const spotIds = zones.filter((z) => z.kind !== "room").flatMap((z) => z.spots.map((s) => s.id));
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
        const { item, category } = pick(pool);
        const qty = 1 + Math.floor(rand() * 3);
        const line: LineRequest = item.variants
          ? { itemId: item.id, size: pick(item.variants).size, qty }
          : { itemId: item.id, qty };
        // Random numbers are drawn only for what the catalog has, so a catalog without extras replays as before.
        const extras: string[] = [];
        for (const g of groupsOf(catalog, category, item)) {
          const count = g.min > 0 ? g.min : rand() < 0.25 ? 1 : 0;
          const left = [...g.options];
          for (let k = 0; k < count; k++)
            extras.push((left.splice(Math.floor(rand() * left.length), 1)[0] as { id: string }).id);
        }
        if (extras.length > 0) line.extras = extras;
        if (catalog.extras !== undefined && rand() < 0.08) line.note = pick(NOTES);
        lines.push(line);
      }
      const order: RushOrder = { at, lines, payment: rand() < 0.7 ? "upi" : "cash" };
      if (spotIds.length > 0 && rand() < 0.85) order.spot = pick(spotIds);
      return order;
    }),
    ...(opts.events === undefined ? {} : { events: opts.events }),
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
  // 300 orders over a steady afternoon, 12:00 to 17:00 in Lisbon (UTC in November): a garden cafe with spots and extras.
  "garden-cafe": {
    seed: 20261201,
    start: Date.UTC(2026, 11, 1, 12, 0),
    durationMs: 5 * 60 * 60_000,
    count: 300,
    favourites: { categoryIds: ["coffee"], weight: 3 },
    events: [
      { inDays: 0, title: "Lantern night market", note: "Stalls and music in the garden", audience: "all", rush: true },
      {
        inDays: 0,
        title: "Folk music in the garden",
        start: "16:30",
        end: "18:00",
        repeat: { weekdays: ["sun"] },
        price: 500,
        note: "Entry at the gate",
      },
      {
        inDays: 3,
        title: "Big produce delivery",
        start: "08:00",
        note: "Clear the store room the night before",
        audience: "staff",
      },
    ],
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
