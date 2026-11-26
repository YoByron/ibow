/**
 * Seeds a demo database: the 7 days before today in full and today up to the demo's start, each an ordinary day across
 * the business's opening hours (07:00 to 22:00 business-local without them), shaped by the sample's own hourly profile
 * or, without one, a morning, a lunch and an evening peak with quieter hours between.
 * Orders are drawn from the sample's `rush.json` (its baskets and payment mix) and go through the real order and
 * payment rules, so the owner's dashboard has a day running, a fair comparison with yesterday and a forecast. With a room
 * zone a few of today's orders are left on room bills, and the sample's `events` are put on the calendar (D-086).
 * A demo that keeps its database (`demo-serve`, a Worker) is topped up to the clock by `topUpDemo`, so the next day's
 * Today never starts empty. Only the demo calls this, on a database it marked.
 */

import { randomBytes } from "node:crypto";
import { addDays, type EventInput, parseEvent } from "../core/calendar.ts";
import type { Config } from "../core/config.ts";
import type { Hours } from "../core/hours.ts";
import { localTime } from "../core/insights.ts";
import {
  advanceStatus,
  createOrder,
  type LineRequest,
  markReady,
  markServed,
  type Order,
  orderTotal,
} from "../core/orders.ts";
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
/** Orders of the day left on room bills, when the business lets rooms. */
const ROOM_BILLS = 4;
/** Where the seed remembers how far it has placed orders, so a top-up adds only what came after. */
export const SEEDED_UNTIL = "demo_seeded_until";
/** A top-up covers at most this many days; a demo idle longer starts its history afresh from there. */
const TOP_UP_DAYS = 8;
/**
 * Relative orders per business-local hour, 07:00 to 21:59: a breakfast peak, a lunch peak, the evening rush. The profile
 * of a sample whose `rush.json` has no `hourWeights`.
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

/** An event of the demo, placed relative to the demo's day: `inDays` after it (0 today), at `start` or two hours from now. */
export interface DemoEvent extends Omit<EventInput, "date" | "start" | "audience" | "rush" | "repeat"> {
  inDays: number;
  start?: string;
  audience?: EventInput["audience"];
  rush?: boolean;
  repeat?: { weekdays: (string | number)[]; until?: string };
}

/** The parts of a sample's `rush.json` the seed reads: its orders' baskets and payment methods, not their times. */
export interface DemoRush {
  start: number;
  durationMs: number;
  orders: { at: number; lines: LineRequest[]; payment: PaymentMethod; spot?: string }[];
  /** Relative orders per business-local hour (`{"9": 4, "13": 6}`), for a business busy at other times than the default. */
  hourWeights?: Record<string, number>;
  /** Events the demo puts on the calendar, by days from its start. */
  events?: DemoEvent[];
}

/**
 * Each profile hour's weight and the minutes of it the business is open: the whole hour without opening hours, the part
 * inside them with. An overnight day (closing before opening) or an all-day one keeps every hour whole. Hours the
 * business is shut get no orders, and the weights shrink with the minutes kept, so a short hour gets its share.
 */
export function openSlots(
  weights: Readonly<Record<string, number>>,
  hours: Hours | undefined,
): { hour: number; weight: number; from: number; to: number }[] {
  const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const open = hours === undefined ? 0 : minutes(hours.open);
  const close = hours === undefined ? 0 : minutes(hours.close);
  const clip = open < close;
  const out: { hour: number; weight: number; from: number; to: number }[] = [];
  for (const [h, w] of Object.entries(weights)) {
    const hour = Number(h);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !(w > 0)) {
      throw new Error(`seedDemo: expected hourWeights keyed 0 to 23 with positive weights, found ${h}: ${w}`);
    }
    const from = clip ? Math.max(0, open - hour * 60) : 0;
    const to = clip ? Math.min(60, close - hour * 60) : 60;
    if (to > from) out.push({ hour, weight: (w * (to - from)) / 60, from, to });
  }
  if (out.length === 0) {
    throw new Error(
      `seedDemo: expected the hourly profile to overlap the opening hours ${hours?.open}-${hours?.close}, found no hour that does`,
    );
  }
  return out;
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
const REVIEWS = ["Quick and hot", "Loved it", "Busy, but my order came fast", "Will come again", "", ""];

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

type Slot = { at: number; o: DemoRush["orders"][number] };

/**
 * One business day's order times and baskets, from a random stream of that day alone: the same day always gets the same
 * orders, so a top-up later in the day adds exactly the ones a fresh seed would have placed by then.
 */
function daySlots(input: DemoSeedInput, day: string): Slot[] {
  const { config, rush } = input;
  const rand = prng((input.seed ?? 1) * 1000 + Number(day.replaceAll("-", "")));
  const slotsOfDay = openSlots(rush.hourWeights ?? HOUR_WEIGHTS, config.business.hours);
  const weightSum = slotsOfDay.reduce((a, s) => a + s.weight, 0);
  // Busier and quieter days: 75 to 105% of the sample's rush size.
  const size = rush.orders.length * (input.scale ?? 1) * (0.75 + 0.3 * rand());
  const slots: Slot[] = [];
  for (const { hour, weight, from, to } of slotsOfDay) {
    const count = Math.round(((size * weight) / weightSum) * (0.85 + 0.3 * rand()));
    for (let i = 0; i < count; i++) {
      const at = zonedTime(day, hour * 60 + from, config.business.timeZone) + Math.floor(rand() * (to - from) * MINUTE);
      slots.push({ at, o: rush.orders[Math.floor(rand() * rush.orders.length)] as Slot["o"] });
    }
  }
  return slots.sort((a, b) => a.at - b.at);
}

/** The room spots of the business, in `spots.json` order; none without a room zone. */
const roomSpots = (config: Config): string[] =>
  config.zones.filter((z) => z.kind === "room").flatMap((z) => z.spots.map((s) => s.id));

/**
 * Places a day's slots through the real rules: older ones collected and paid, the last half hour of today open, and
 * `roomBill` ones delivered to a room and left on its bill. Returns how many it placed and left open.
 */
function place(
  store: Store,
  input: DemoSeedInput,
  slots: readonly Slot[],
  opts: { today: boolean; tag: string; rand: () => number; rooms: Map<number, string> },
): { orders: number; open: number } {
  const { config, now } = input;
  const { rand } = opts;
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const zone = config.business.timeZone;
  const recent = opts.today ? slots.filter((p) => p.at > now - OPEN_WINDOW).slice(-MAX_OPEN) : [];
  let open = 0;
  slots.forEach(({ at, o }, i) => {
    const fromEnd = slots.length - i;
    const stage = fromEnd > recent.length ? "done" : fromEnd > PENDING ? "preparing" : "pending";
    const room = stage === "done" ? opts.rooms.get(i) : undefined;
    const name = rand() < 0.3 ? pick(NAMES) : undefined;
    const id = `demo-${opts.tag}-${i}-${at}`;
    const spot = room ?? o.spot;
    const { order: placed } = store.createOrder({
      id,
      secret: randomBytes(24).toString("base64url"),
      clientKey: randomBytes(16).toString("base64url"),
      now: at,
      timeZone: zone,
      build: (token) =>
        createOrder(config, {
          id,
          token,
          now: at,
          lines: o.lines,
          ...(name ? { customerName: name } : {}),
          ...(spot === undefined || !config.spots.has(spot) ? {} : { spotId: spot }),
          ...(room === undefined ? {} : { pay: "room" as const }),
        }),
    });
    const method: PaymentMethod = input.upi && o.payment === "upi" ? "upi" : "cash";
    const amountMinor = orderTotal(placed);
    let order: Order = placed;
    let last = at + 20_000;
    if (stage === "pending") {
      if (method === "upi" && rand() < 0.6)
        order = { ...order, payment: claimPayment(order.payment, { method, amountMinor, now: at + 20_000 }) };
    } else {
      // A room's order is carried up and stays on its bill; every other one is paid at the counter.
      const paid = { by: "counter", method, amountMinor, now: at + 20_000 };
      order = advanceStatus(
        room === undefined ? { ...order, payment: confirmPayment(order.payment, paid) } : order,
        at + 40_000,
      );
      const stations = [...new Set(order.lines.map((l) => l.stationId))];
      // A dish waits a minute or three at the pass before it is carried out.
      const readyAt = at + (2 + Math.floor(rand() * 3)) * MINUTE;
      // Some stations have finished their part of an order being prepared; all have for one collected.
      for (const s of stations) {
        if (stage === "done" || rand() < 0.4) {
          const lines = order.lines.flatMap((l, idx) => (l.stationId === s ? [idx] : []));
          order = markReady(order, s, lines, readyAt);
        }
      }
      if (stage === "done") {
        const collected = Math.min(at + (5 + Math.floor(rand() * 6)) * MINUTE, now - 10_000);
        order.lines.forEach((_, idx) => {
          order = markServed(order, idx, collected);
        });
        // Handed over and paid (or on a room bill) already closes it (D-097); an unpaid one is closed by the counter.
        if (order.status !== "completed") order = advanceStatus(order, collected);
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
    if (stage !== "done") open++;
  });
  return { orders: slots.length, open };
}

/** Which of a day's collected orders go on room bills: a few, spread over the day, each to one of the first rooms. */
function roomPicks(config: Config, slots: readonly Slot[], openCount: number): Map<number, string> {
  const rooms = roomSpots(config);
  const out = new Map<number, string>();
  const done = slots.length - openCount;
  if (rooms.length === 0 || done < ROOM_BILLS) return out;
  for (let j = 0; j < ROOM_BILLS; j++) {
    out.set(Math.floor(((j + 0.5) * done) / ROOM_BILLS), rooms[j % Math.min(3, rooms.length)] as string);
  }
  return out;
}

/** The sample's events, placed on the calendar relative to `today`; today's without a start begins two hours from now. */
export function demoEvents(events: readonly DemoEvent[], today: string, nowMinute: number): EventInput[] {
  return events.map((e, i) => {
    const later = Math.min(23 * 60 + 30, Math.ceil((nowMinute + 120) / 30) * 30);
    const start =
      e.start ?? `${String(Math.floor(later / 60)).padStart(2, "0")}:${String(later % 60).padStart(2, "0")}`;
    const { inDays, ...rest } = e;
    return parseEvent({ ...rest, date: addDays(today, inDays), start }, `rush.json events[${i}].`);
  });
}

export function seedDemo(store: Store, input: DemoSeedInput): DemoSeedResult {
  const { config, rush, now } = input;
  if (rush.orders.length === 0) throw new Error("seedDemo: expected a rush with orders, found none");
  const rand = prng((input.seed ?? 1) * 1000 + (input.only ?? 0));
  const pastDays = input.pastDays ?? PAST_DAYS;
  const zone = config.business.timeZone;
  const todayKey = dayKey(now, zone);
  let orders = 0;
  let open = 0;
  const days = input.only === undefined ? Array.from({ length: pastDays + 1 }, (_, i) => pastDays - i) : [input.only];
  const roomDay =
    daySlots(input, todayKey).filter((p) => p.at <= now - LEAD - OPEN_WINDOW).length >= ROOM_BILLS ? 0 : 1;
  for (const k of days) {
    const today = k === 0;
    const slots = daySlots(input, addDays(todayKey, -k)).filter((p) => p.at <= now - LEAD);
    const openCount = today ? slots.filter((p) => p.at > now - OPEN_WINDOW).slice(-MAX_OPEN).length : 0;
    // Room bills are left open today, or, before today has enough orders (early morning), on yesterday's.
    const rooms = k === roomDay ? roomPicks(config, slots, openCount) : new Map<number, string>();
    const placed = place(store, input, slots, { today, tag: String(k), rand, rooms });
    orders += placed.orders;
    open += placed.open;
  }
  if (input.only === undefined || input.only === 0) {
    const t = localTime(now, zone);
    for (const e of demoEvents(rush.events ?? [], t.day, t.hour * 60 + t.minute))
      store.addCalendarEvent(e, "demo", now);
    // The demo's own events stand in for an events.json, which it does not read.
    store.setMeta("events_seeded", String(now));
    store.setMeta(SEEDED_UNTIL, String(now));
  }
  return { days: days.length, orders, open };
}

/**
 * Brings a demo that kept its database up to the clock: the orders a fresh seed would have placed since the last seed or
 * top-up, day by day up to now, through the same rules (the newest half hour of today left open). Run when a kept demo
 * starts and every hour, so "Today" on the owner's dashboard reads like a day in progress, never "2 orders, down 85%".
 * Returns how many orders it placed; none when the demo was never seeded by this version or is already up to date.
 */
export function topUpDemo(store: Store, input: Omit<DemoSeedInput, "only" | "pastDays">): number {
  const raw = store.meta(SEEDED_UNTIL);
  const { config, now } = input;
  const until = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isFinite(until) || now - LEAD <= until) return 0;
  const zone = config.business.timeZone;
  const todayKey = dayKey(now, zone);
  let day = dayKey(Math.max(until, now - TOP_UP_DAYS * 86_400_000), zone);
  const rand = prng(Math.floor(now / MINUTE));
  let placed = 0;
  for (; day <= todayKey; day = addDays(day, 1)) {
    const today = day === todayKey;
    const slots = daySlots(input, day).filter((p) => p.at > until && p.at <= now - LEAD);
    placed += place(store, input, slots, {
      today,
      tag: `${day}-${Math.floor(now / MINUTE)}`,
      rand,
      rooms: new Map(),
    }).orders;
  }
  store.setMeta(SEEDED_UNTIL, String(now));
  return placed;
}
