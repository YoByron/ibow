/**
 * Seeds a demo database: the 7 days before today in full and today up to the demo's start, each an ordinary day across
 * opening hours (07:00 to 22:00 business-local) with a morning, a lunch and an evening peak and quieter hours between.
 * Orders are drawn from the sample's `rush.json` (its baskets and payment mix) and go through the real order and
 * payment rules, so the owner's dashboard has a day running, a fair comparison with yesterday and a forecast. Only
 * `npm run demo` calls this, on a database it marked.
 */

import { randomBytes } from "node:crypto";
import type { Config } from "../core/config.ts";
import { advanceStatus, createOrder, type LineRequest, markReady, type Order, orderTotal } from "../core/orders.ts";
import { claimPayment, confirmPayment, type PaymentMethod } from "../core/payments.ts";
import { reviewOrder } from "../core/reviews.ts";
import { dayKey } from "../core/tokens.ts";
import type { Store } from "../store/store.ts";

const MINUTE = 60_000;
/** Days seeded before today: one full week, so tomorrow's weekday has a day to forecast from. */
const PAST_DAYS = 7;
/** Nothing is placed in the last minute before the demo starts. */
const LEAD = MINUTE;
/** Today's orders of the last half hour stay open, at most 12: the newest 5 still pending, the rest being prepared. */
const OPEN_WINDOW = 30 * MINUTE;
const PENDING = 5;
const MAX_OPEN = 12;
/**
 * Relative orders per business-local hour, 07:00 to 21:59: a breakfast peak, a lunch peak, the evening rush. One
 * generic profile for every sample, since the config has no opening hours.
 */
const HOUR_WEIGHTS: Readonly<Record<number, number>> = {
  7: 1,
  8: 3,
  9: 4,
  10: 2,
  11: 2,
  12: 4,
  13: 5,
  14: 2,
  15: 1,
  16: 1.5,
  17: 3,
  18: 5,
  19: 6,
  20: 3,
  21: 1.5,
};
const WEIGHT_SUM = Object.values(HOUR_WEIGHTS).reduce((a, b) => a + b, 0);

/** The parts of a sample's `rush.json` the seed reads: its orders' baskets and payment methods, not their times. */
export interface DemoRush {
  start: number;
  durationMs: number;
  orders: { at: number; lines: LineRequest[]; payment: PaymentMethod }[];
}

export interface DemoSeedInput {
  config: Config;
  rush: DemoRush;
  /** The demo's start; nothing is placed after it. */
  now: number;
  /** Whether the demo offers UPI; without it every payment is cash. */
  upi: boolean;
  seed?: number;
  /** Days before today to seed (default 7). */
  pastDays?: number;
  /** A fraction of the sample's rush size per day (default 1): a smaller demo costs fewer rows on a metered host. */
  scale?: number;
  /** Seed only this day, `k` days before today (0 is today), so a host can spread the seed over several invocations. */
  only?: number;
}

export interface DemoSeedResult {
  /** Business days seeded, today included. */
  days: number;
  orders: number;
  /** Today's orders left open for the counter and stations (none before opening or after closing). */
  open: number;
}

// Invented first names from many places; a few repeat across days, so the owner sees "Returning" badges.
const NAMES = ["Asha", "Ravi", "Meera", "Sam", "Lina", "Omar", "Priya", "Tom", "Nia", "Arjun", "Zara", "Kenji"];
const REVIEWS = ["Quick and hot", "Loved it", "Busy, but my token came fast", "Will come again", "", ""];

/** mulberry32, as the rush generator uses: small and the same on every platform. */
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

/** The epoch time of a business-local wall-clock time on `day` (YYYY-MM-DD) in `zone`. */
function zonedTime(day: string, minuteOfDay: number, zone: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d, 0, minuteOfDay);
  const offset = (at: number) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
        .formatToParts(at)
        .map((x) => [x.type, Number(x.value)]),
    ) as Record<string, number>;
    return Date.UTC(p.year as number, (p.month as number) - 1, p.day, p.hour, p.minute) - at;
  };
  // Twice, so a guess on the other side of a clock change settles.
  const first = wall - offset(wall);
  return wall - offset(first);
}

/** The calendar day `k` days before `day`. */
function daysBefore(day: string, k: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - k)).toISOString().slice(0, 10);
}

export function seedDemo(store: Store, input: DemoSeedInput): DemoSeedResult {
  const { config, rush, now } = input;
  if (rush.orders.length === 0) throw new Error("seedDemo: expected a rush with orders, found none");
  const rand = prng((input.seed ?? 1) * 1000 + (input.only ?? 0));
  const pastDays = input.pastDays ?? PAST_DAYS;
  const scale = input.scale ?? 1;
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const zone = config.business.timeZone;
  const todayKey = dayKey(now, zone);
  let orders = 0;
  let open = 0;
  let n = 0;

  const days = input.only === undefined ? Array.from({ length: pastDays + 1 }, (_, i) => pastDays - i) : [input.only];
  for (const k of days) {
    const today = k === 0;
    const key = daysBefore(todayKey, k);
    // Busier and quieter days: 75 to 105% of the sample's rush size.
    const size = rush.orders.length * scale * (0.75 + 0.3 * rand());
    const slots: { at: number; o: DemoRush["orders"][number] }[] = [];
    for (const [hour, weight] of Object.entries(HOUR_WEIGHTS)) {
      const count = Math.round(((size * weight) / WEIGHT_SUM) * (0.85 + 0.3 * rand()));
      for (let i = 0; i < count; i++) {
        const at = zonedTime(key, Number(hour) * 60, zone) + Math.floor(rand() * 3_600_000);
        slots.push({ at, o: pick(rush.orders) });
      }
    }
    slots.sort((a, b) => a.at - b.at);
    const day = slots.filter((p) => p.at <= now - LEAD);
    const recent = today ? day.filter((p) => p.at > now - OPEN_WINDOW).slice(-MAX_OPEN) : [];
    day.forEach(({ at, o }, i) => {
      const fromEnd = day.length - i;
      const stage = fromEnd > recent.length ? "done" : fromEnd > PENDING ? "preparing" : "pending";
      n++;
      const name = rand() < 0.3 ? pick(NAMES) : undefined;
      const id = `demo-${k}-${n}`;
      const { order: placed } = store.createOrder({
        id,
        secret: randomBytes(24).toString("base64url"),
        clientKey: randomBytes(16).toString("base64url"),
        now: at,
        timeZone: zone,
        build: (token) =>
          createOrder(config, { id, token, now: at, lines: o.lines, ...(name ? { customerName: name } : {}) }),
      });
      const method: PaymentMethod = input.upi && o.payment === "upi" ? "upi" : "cash";
      const amountMinor = orderTotal(placed);
      let order: Order = placed;
      let last = at + 20_000;
      if (stage === "pending") {
        if (method === "upi" && rand() < 0.6)
          order = { ...order, payment: claimPayment(order.payment, { method, amountMinor, now: at + 20_000 }) };
      } else {
        const paid = { by: "counter", method, amountMinor, now: at + 20_000 };
        order = advanceStatus({ ...order, payment: confirmPayment(order.payment, paid) }, at + 40_000);
        const stations = [...new Set(order.lines.map((l) => l.stationId))];
        // Some stations have finished their part of an order being prepared; all have for one collected.
        for (const s of stations) {
          if (stage === "done" || rand() < 0.4) {
            const lines = order.lines.flatMap((l, idx) => (l.stationId === s ? [idx] : []));
            order = markReady(order, s, lines);
          }
        }
        if (stage === "done") {
          const collected = Math.min(at + (3 + Math.floor(rand() * 6)) * MINUTE, now - 10_000);
          order = advanceStatus(order, collected);
          last = collected;
          const reviewAt = collected + 5 * MINUTE;
          if (rand() < 0.05 && reviewAt < now) {
            const text = pick(REVIEWS);
            const rating = pick([5, 5, 5, 4, 4, 3]);
            store.putReview(reviewOrder(order, { rating, now: reviewAt, ...(text ? { text } : {}) }));
          }
        }
      }
      if (order !== placed) store.saveOrder(order, "order.status", last);
      orders++;
      if (stage !== "done") open++;
    });
  }
  return { days: days.length, orders, open };
}
