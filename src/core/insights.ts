/**
 * Rule-based reports over orders for the owner (D-003): the day's hourly chart, peak hour, popular items, today
 * against yesterday, a prep forecast for tomorrow and a summary of facts. Pure: orders and the clock come in, numbers
 * go out, in minor units of the business currency and hours of the business time zone. Formatting (Intl, words)
 * happens at the edge. Only anonymous counts are read: no customer name reaches a report.
 *
 * Two kinds of money, never mixed (D-015, D-007): **ordered** is the value of the orders placed in the day, whatever
 * their payment (demand: the chart, popular items and the forecast count it); **received** is money a person confirmed,
 * on the day it was confirmed. An order still owing money is **awaiting confirmation**, so a claim that is never paid
 * shows as awaiting, never as received.
 */

import { type Order, type OrderLine, onOpenRoomBill } from "./orders.ts";
import type { PaymentMethod } from "./payments.ts";

/**
 * Money a person confirmed for an order: the confirmation and each top-up, at the time each was confirmed. A refund is a
 * receipt with a negative amount at the time it was handed back, so every total nets it on its own day and method.
 */
export interface Receipt {
  amountMinor: number;
  at: number;
  /** How it was paid, when known; the split of the day's received money reads it. */
  method?: PaymentMethod | undefined;
}

/** What insights read of an order: when, its lines and the money confirmed for it. No name. */
export interface Sale {
  createdAt: number;
  lines: readonly Pick<OrderLine, "itemId" | "name" | "size" | "qty" | "unitMinor">[];
  received: readonly Receipt[];
  /** On a room bill not yet settled: owed at checkout, not awaiting a confirmation (D-082), so Awaiting leaves it out. */
  onRoomBill?: true;
}

/** The parts of an order insights read. A claim counts for nothing: only a confirmed payment is money received. */
export function saleOf(order: Order): Sale {
  const p = order.payment;
  const received: Receipt[] = [];
  if (p.state === "confirmed") {
    const topUps = p.topUps ?? [];
    const base = p.amountMinor - topUps.reduce((n, t) => n + t.amountMinor, 0);
    received.push(
      { amountMinor: base, at: p.at, method: p.method },
      ...topUps.map((t) => ({ amountMinor: t.amountMinor, at: t.at, method: t.method })),
      ...(p.refunds ?? []).map((r) => ({ amountMinor: -r.amountMinor, at: r.at, method: r.method })),
    );
  }
  const sale: Sale = { createdAt: order.createdAt, lines: order.lines, received };
  return onOpenRoomBill(order) ? { ...sale, onRoomBill: true } : sale;
}

export interface LocalTime {
  /** `YYYY-MM-DD` in the business time zone. */
  day: string;
  hour: number;
  minute: number;
}

const BUCKET_MS = 30 * 60_000;
const MAX_CACHED_BUCKETS = 20_000;
const formatters = new Map<string, Intl.DateTimeFormat>();
/** Per time zone: the UTC offset at the start of each half hour already asked about. */
const offsets = new Map<string, Map<number, number>>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/**
 * The zone's offset from UTC at an instant, found once per half hour with `Intl` and then reused: a report touches
 * thousands of orders but only a few dozen distinct half hours, and `formatToParts` per order cost seconds (D-044).
 * Zones change their offset on a half-hour boundary of UTC, so the offset at a bucket's start holds for all of it.
 */
function offsetAt(at: number, timeZone: string): number {
  let cache = offsets.get(timeZone);
  if (cache === undefined) {
    cache = new Map();
    offsets.set(timeZone, cache);
  }
  const bucket = Math.floor(at / BUCKET_MS);
  const known = cache.get(bucket);
  if (known !== undefined) return known;
  const start = bucket * BUCKET_MS;
  const p = Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(start)
      .map((x) => [x.type, x.value]),
  );
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  if (cache.size >= MAX_CACHED_BUCKETS) cache.clear();
  cache.set(bucket, wall - start);
  return wall - start;
}

/** The business-local date and clock time of an instant. */
export function localTime(at: number, timeZone: string): LocalTime {
  const d = new Date(at + offsetAt(at, timeZone));
  const two = (n: number) => String(n).padStart(2, "0");
  return {
    day: `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`,
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

/** The calendar day `n` days after `day` (negative for before). Calendar arithmetic, so no zone or DST is involved. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export interface DayTotals {
  /** Orders placed in the day. */
  orders: number;
  /** Units across every line of them. */
  items: number;
  /** Their value at their totals, paid or not. */
  orderedMinor: number;
  /** Order value per order, rounded to the nearest minor unit; 0 with no orders. */
  averageMinor: number;
  /** Money staff confirmed in the day, whenever its order was placed. */
  receivedMinor: number;
  /** The part of it staff confirmed as cash and as UPI; a receipt with no recorded method counts in neither. */
  receivedCashMinor: number;
  receivedUpiMinor: number;
  receivedCardMinor: number;
  /** Orders placed in the day whose confirmed money doesn't cover them yet, and what they still owe. */
  awaitingOrders: number;
  awaitingMinor: number;
}

export interface HourBucket {
  /** 0 to 23, business-local. On a day the clocks go back, the repeated hour's orders share one bucket. */
  hour: number;
  orders: number;
  items: number;
  orderedMinor: number;
}

export interface ItemStat {
  itemId: string;
  name: string;
  qty: number;
  orderedMinor: number;
}

export interface ForecastLine {
  itemId: string;
  name: string;
  size?: string;
  qty: number;
}

export interface Forecast {
  /** The day forecast: tomorrow, business-local. */
  day: string;
  /**
   * `same-weekday`: the mean of the same weekday over the last 4 weeks, counting only those days with orders.
   * `recent`: no such weekday had orders, so the mean of the last 7 days that had orders. `none`: no history at all.
   */
  basis: "same-weekday" | "recent" | "none";
  /** The days the mean was taken over. */
  basisDays: string[];
  orders: number;
  /** Per item and size, rounded up so the prep doesn't fall short; most first. */
  lines: ForecastLine[];
}

export interface Comparison {
  today: DayTotals;
  /** Yesterday up to the same business-local clock time as now: a fair race while today is still running. */
  yesterdaySoFar: DayTotals;
  /** The whole of yesterday. */
  yesterday: DayTotals;
  /** Whole percent change of today against yesterday so far; null when yesterday had nothing by now. */
  ordersChangePct: number | null;
  receivedChangePct: number | null;
}

export type SummaryFact =
  | { kind: "none" }
  | {
      kind: "orders";
      orders: number;
      orderedMinor: number;
      receivedMinor: number;
      awaitingOrders: number;
      awaitingMinor: number;
    }
  | { kind: "trend"; direction: "up" | "down" | "flat"; ordersChangePct: number; receivedChangePct: number | null }
  | { kind: "peak"; hour: number; orders: number }
  | { kind: "top"; name: string; qty: number }
  | { kind: "topValue"; name: string; orderedMinor: number }
  | { kind: "forecast"; day: string; orders: number; lines: ForecastLine[]; basis: "same-weekday" | "recent" };

export interface Report {
  day: string;
  totals: DayTotals;
  hourly: HourBucket[];
  peak: HourBucket | null;
  popular: { byQty: ItemStat[]; byValue: ItemStat[] };
  comparison: Comparison;
  forecast: Forecast;
  summary: SummaryFact[];
}

/** A change smaller than this, either way, is "about the same". */
export const FLAT_PCT = 10;
const FORECAST_WEEKS = 4;
const RECENT_DAYS = 7;

function units(order: Sale): number {
  return order.lines.reduce((n, l) => n + l.qty, 0);
}

function total(order: Sale): number {
  return order.lines.reduce((n, l) => n + l.qty * l.unitMinor, 0);
}

function minutes(t: LocalTime): number {
  return t.hour * 60 + t.minute;
}

/** Orders placed on a business-local day. */
export function ordersOn(orders: readonly Sale[], day: string, timeZone: string): Sale[] {
  return orders.filter((o) => localTime(o.createdAt, timeZone).day === day);
}

/**
 * A business-local day's totals: orders placed in it and money confirmed in it, up to `untilMinute` of its clock
 * (minutes after midnight; the whole day by default). Awaiting is as those orders stand now.
 */
export function dayTotals(sales: readonly Sale[], day: string, timeZone: string, untilMinute = 24 * 60): DayTotals {
  const within = (at: number) => {
    const t = localTime(at, timeZone);
    return t.day === day && minutes(t) <= untilMinute;
  };
  let orders = 0;
  let items = 0;
  let orderedMinor = 0;
  let receivedMinor = 0;
  let receivedCashMinor = 0;
  let receivedUpiMinor = 0;
  let receivedCardMinor = 0;
  let awaitingOrders = 0;
  let awaitingMinor = 0;
  for (const s of sales) {
    for (const r of s.received) {
      if (!within(r.at)) continue;
      receivedMinor += r.amountMinor;
      if (r.method === "cash") receivedCashMinor += r.amountMinor;
      else if (r.method === "upi") receivedUpiMinor += r.amountMinor;
      else if (r.method === "card") receivedCardMinor += r.amountMinor;
    }
    if (!within(s.createdAt)) continue;
    const value = total(s);
    orders++;
    items += units(s);
    orderedMinor += value;
    const owed = value - s.received.reduce((n, r) => (r.amountMinor > 0 ? n + r.amountMinor : n), 0);
    if (owed > 0 && s.onRoomBill !== true) {
      awaitingOrders++;
      awaitingMinor += owed;
    }
  }
  const averageMinor = orders === 0 ? 0 : Math.round(orderedMinor / orders);
  return {
    orders,
    items,
    orderedMinor,
    averageMinor,
    receivedMinor,
    receivedCashMinor,
    receivedUpiMinor,
    receivedCardMinor,
    awaitingOrders,
    awaitingMinor,
  };
}

/** 24 buckets, one per business-local hour of `day`, empty hours included so a chart has every bar. */
export function hourly(orders: readonly Sale[], day: string, timeZone: string): HourBucket[] {
  const buckets = Array.from({ length: 24 }, (_, hour): HourBucket => ({ hour, orders: 0, items: 0, orderedMinor: 0 }));
  for (const o of orders) {
    const t = localTime(o.createdAt, timeZone);
    if (t.day !== day) continue;
    const b = buckets[t.hour] as HourBucket;
    b.orders++;
    b.items += units(o);
    b.orderedMinor += total(o);
  }
  return buckets;
}

/** The hour with the most orders (the earliest on a tie); null when there were none. */
export function peakHour(buckets: readonly HourBucket[]): HourBucket | null {
  let best: HourBucket | null = null;
  for (const b of buckets) if (b.orders > 0 && (best === null || b.orders > best.orders)) best = b;
  return best;
}

/** Items by units ordered and by order value, all sizes together. Ties go to the other measure, then the name. */
export function popularItems(orders: readonly Sale[]): { byQty: ItemStat[]; byValue: ItemStat[] } {
  const stats = new Map<string, ItemStat>();
  for (const o of orders) {
    for (const l of o.lines) {
      const s = stats.get(l.itemId) ?? { itemId: l.itemId, name: l.name, qty: 0, orderedMinor: 0 };
      s.qty += l.qty;
      s.orderedMinor += l.qty * l.unitMinor;
      stats.set(l.itemId, s);
    }
  }
  const all = [...stats.values()];
  const byName = (a: ItemStat, b: ItemStat) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const byQty = [...all].sort((a, b) => b.qty - a.qty || b.orderedMinor - a.orderedMinor || byName(a, b));
  const byValue = [...all].sort((a, b) => b.orderedMinor - a.orderedMinor || b.qty - a.qty || byName(a, b));
  return { byQty, byValue };
}

function changePct(now: number, before: number): number | null {
  return before === 0 ? null : Math.round(((now - before) / before) * 100);
}

export function compareWithYesterday(sales: readonly Sale[], now: number, timeZone: string): Comparison {
  const t = localTime(now, timeZone);
  const yesterday = addDays(t.day, -1);
  const today = dayTotals(sales, t.day, timeZone);
  const yesterdaySoFar = dayTotals(sales, yesterday, timeZone, minutes(t));
  return {
    today,
    yesterdaySoFar,
    yesterday: dayTotals(sales, yesterday, timeZone),
    ordersChangePct: changePct(today.orders, yesterdaySoFar.orders),
    receivedChangePct: changePct(today.receivedMinor, yesterdaySoFar.receivedMinor),
  };
}

/** What the forecast needs of one business day: how many orders, and the units per item and size. */
export interface DayLines {
  orders: number;
  lines: readonly { itemId: string; name: string; size?: string; qty: number }[];
}

/** One business day, aggregated: the totals, the 24 hourly buckets and the units per item and size. */
export interface DayStats extends DayTotals {
  /** 24 buckets, business-local hours. */
  hourly: { orders: number; items: number; orderedMinor: number }[];
  /** Per item and size. */
  lines: { itemId: string; name: string; size?: string; qty: number; orderedMinor: number }[];
}

/** What happened in one minute of a business day, so "up to 15:30" is a sum over a short list, not a query (D-046). */
export interface MinuteSlot {
  /** Minute of the business-local day, 0 to 1439. */
  m: number;
  orders: number;
  items: number;
  orderedMinor: number;
  awaitingOrders: number;
  awaitingMinor: number;
  /** Money confirmed in this minute, whenever its order was placed. */
  receivedMinor: number;
  /** The part of it confirmed as cash and as UPI. */
  receivedCashMinor: number;
  receivedUpiMinor: number;
  receivedCardMinor: number;
}

/**
 * A business day's totals once it is over, kept in the store (D-044). Frozen at the close: later changes aren't added,
 * so what orders placed that day still owed at the close (`awaiting*`) stays as it was then.
 */
export interface DayRecord extends DayStats {
  /** Only the minutes in which something happened. */
  minutes: MinuteSlot[];
  day: string;
  /** Money confirmed on that day's orders (whenever it was confirmed). */
  confirmedMinor: number;
}

/** The forecast's view of some sales, grouped by business-local day. */
export function dayLinesOf(sales: readonly Sale[], timeZone: string): Map<string, DayLines> {
  const byDay = new Map<string, { orders: number; sums: Map<string, ForecastLine> }>();
  for (const o of sales) {
    const day = localTime(o.createdAt, timeZone).day;
    const d = byDay.get(day) ?? { orders: 0, sums: new Map() };
    byDay.set(day, d);
    d.orders++;
    for (const l of o.lines) {
      const key = `${l.itemId}\u0000${l.size ?? ""}`;
      const s = d.sums.get(key) ?? {
        itemId: l.itemId,
        name: l.name,
        ...(l.size === undefined ? {} : { size: l.size }),
        qty: 0,
      };
      s.qty += l.qty;
      d.sums.set(key, s);
    }
  }
  return new Map([...byDay].map(([day, d]) => [day, { orders: d.orders, lines: [...d.sums.values()] }]));
}

/** Every day the forecast could take its mean over: the same weekday for 4 weeks, and the last 7 days. */
export function forecastDays(now: number, timeZone: string): string[] {
  const today = localTime(now, timeZone).day;
  const target = addDays(today, 1);
  const weekdays = Array.from({ length: FORECAST_WEEKS }, (_, i) => addDays(target, -7 * (i + 1)));
  const recent = Array.from({ length: RECENT_DAYS }, (_, i) => addDays(today, -i));
  return [...new Set([...weekdays, ...recent])].sort();
}

/**
 * The first instant a report needs orders from: the start of yesterday anywhere on earth. Today and yesterday are read
 * as orders (yesterday "so far" needs the clock); older days come from their stored totals (`closed`, D-044).
 */
export function historyStart(now: number, timeZone: string): number {
  const yesterday = addDays(localTime(now, timeZone).day, -1);
  return Date.parse(`${yesterday}T00:00:00Z`) - 14 * 3_600_000;
}

/**
 * Tomorrow's prep (D-015): for each item and size, the mean units ordered on the same weekday over the last 4 weeks,
 * counting only those days that had orders (a day the business was shut says nothing about demand). With none, the
 * mean over the last 7 days that had orders. Means are rounded up. `byDay` holds each day's lines, complete days only.
 */
export function forecastFromDays(byDay: ReadonlyMap<string, DayLines>, now: number, timeZone: string): Forecast {
  const today = localTime(now, timeZone).day;
  const target = addDays(today, 1);
  const has = (day: string) => day <= today && (byDay.get(day)?.orders ?? 0) > 0;
  const weekdays = Array.from({ length: FORECAST_WEEKS }, (_, i) => addDays(target, -7 * (i + 1))).filter(has);
  let basis: Forecast["basis"] = "same-weekday";
  let basisDays = weekdays;
  if (basisDays.length === 0) {
    basis = "recent";
    basisDays = Array.from({ length: RECENT_DAYS }, (_, i) => addDays(today, -i)).filter(has);
  }
  if (basisDays.length === 0) return { day: target, basis: "none", basisDays: [], orders: 0, lines: [] };

  const n = basisDays.length;
  const sums = new Map<string, ForecastLine>();
  let orderCount = 0;
  for (const day of basisDays) {
    const d = byDay.get(day) as DayLines;
    orderCount += d.orders;
    for (const l of d.lines) {
      const key = `${l.itemId}\u0000${l.size ?? ""}`;
      const s = sums.get(key) ?? {
        itemId: l.itemId,
        name: l.name,
        ...(l.size === undefined ? {} : { size: l.size }),
        qty: 0,
      };
      s.qty += l.qty;
      sums.set(key, s);
    }
  }
  const lines = [...sums.values()]
    .map((s) => ({ ...s, qty: Math.ceil(s.qty / n) }))
    .sort(
      (a, b) =>
        b.qty - a.qty || (a.name < b.name ? -1 : a.name > b.name ? 1 : (a.size ?? "") < (b.size ?? "") ? -1 : 1),
    );
  return { day: target, basis, basisDays: [...basisDays].sort(), orders: Math.ceil(orderCount / n), lines };
}

/** The forecast over sales (and days already totalled in `closed`); a day in `orders` is counted from them instead. */
export function prepForecast(
  orders: readonly Sale[],
  now: number,
  timeZone: string,
  closed: ReadonlyMap<string, DayLines> = new Map(),
): Forecast {
  return forecastFromDays(new Map([...closed, ...dayLinesOf(orders, timeZone)]), now, timeZone);
}

export function emptyHourly(): DayStats["hourly"] {
  return Array.from({ length: 24 }, () => ({ orders: 0, items: 0, orderedMinor: 0 }));
}

/**
 * A business day aggregated from sales in one pass, each timestamp converted once: orders placed in the day and money
 * confirmed in it, up to `untilMinute` of its clock. The store computes the same in SQL (`Store.dayStats`).
 */
export function statsFromSales(sales: readonly Sale[], day: string, timeZone: string, untilMinute = 24 * 60): DayStats {
  const hourly = emptyHourly();
  const lines = new Map<string, DayStats["lines"][number]>();
  let orders = 0;
  let items = 0;
  let orderedMinor = 0;
  let receivedMinor = 0;
  let receivedCashMinor = 0;
  let receivedUpiMinor = 0;
  let receivedCardMinor = 0;
  let awaitingOrders = 0;
  let awaitingMinor = 0;
  const within = (at: number) => {
    const t = localTime(at, timeZone);
    return t.day === day && minutes(t) <= untilMinute;
  };
  for (const s of sales) {
    for (const r of s.received) {
      if (!within(r.at)) continue;
      receivedMinor += r.amountMinor;
      if (r.method === "cash") receivedCashMinor += r.amountMinor;
      else if (r.method === "upi") receivedUpiMinor += r.amountMinor;
      else if (r.method === "card") receivedCardMinor += r.amountMinor;
    }
    const t = localTime(s.createdAt, timeZone);
    if (t.day !== day || minutes(t) > untilMinute) continue;
    const value = total(s);
    const qty = units(s);
    orders++;
    items += qty;
    orderedMinor += value;
    const b = hourly[t.hour] as DayStats["hourly"][number];
    b.orders++;
    b.items += qty;
    b.orderedMinor += value;
    const owed = value - s.received.reduce((n, r) => (r.amountMinor > 0 ? n + r.amountMinor : n), 0);
    if (owed > 0) {
      awaitingOrders++;
      awaitingMinor += owed;
    }
    for (const l of s.lines) {
      const key = `${l.itemId}\u0000${l.size ?? ""}`;
      const e = lines.get(key) ?? {
        itemId: l.itemId,
        name: l.name,
        ...(l.size === undefined ? {} : { size: l.size }),
        qty: 0,
        orderedMinor: 0,
      };
      e.qty += l.qty;
      e.orderedMinor += l.qty * l.unitMinor;
      lines.set(key, e);
    }
  }
  const averageMinor = orders === 0 ? 0 : Math.round(orderedMinor / orders);
  return {
    orders,
    items,
    orderedMinor,
    averageMinor,
    receivedMinor,
    receivedCashMinor,
    receivedUpiMinor,
    receivedCardMinor,
    awaitingOrders,
    awaitingMinor,
    hourly,
    lines: [...lines.values()],
  };
}

/** A finished day's totals up to `untilMinute` of its clock (inclusive), from its record alone. */
export function recordUpTo(r: DayRecord, untilMinute: number): DayStats {
  let orders = 0;
  let items = 0;
  let orderedMinor = 0;
  let receivedMinor = 0;
  let receivedCashMinor = 0;
  let receivedUpiMinor = 0;
  let receivedCardMinor = 0;
  let awaitingOrders = 0;
  let awaitingMinor = 0;
  for (const s of r.minutes) {
    if (s.m > untilMinute) continue;
    orders += s.orders;
    items += s.items;
    orderedMinor += s.orderedMinor;
    receivedMinor += s.receivedMinor;
    receivedCashMinor += s.receivedCashMinor;
    receivedUpiMinor += s.receivedUpiMinor;
    receivedCardMinor += s.receivedCardMinor ?? 0;
    awaitingOrders += s.awaitingOrders;
    awaitingMinor += s.awaitingMinor;
  }
  const averageMinor = orders === 0 ? 0 : Math.round(orderedMinor / orders);
  return {
    orders,
    items,
    orderedMinor,
    averageMinor,
    receivedMinor,
    receivedCashMinor,
    receivedUpiMinor,
    receivedCardMinor,
    awaitingOrders,
    awaitingMinor,
    hourly: [],
    lines: [],
  };
}

function totalsOf(d: DayStats): DayTotals {
  const {
    orders,
    items,
    orderedMinor,
    averageMinor,
    receivedMinor,
    receivedCashMinor,
    receivedUpiMinor,
    receivedCardMinor,
  } = d;
  const { awaitingOrders, awaitingMinor } = d;
  return {
    orders,
    items,
    orderedMinor,
    averageMinor,
    receivedMinor,
    receivedCashMinor,
    receivedUpiMinor,
    receivedCardMinor,
    awaitingOrders,
    awaitingMinor,
  };
}

/** The pieces of a report, each aggregated once: the store reads them in SQL, `dailyReport` from sales. */
export interface ReportDays {
  /** Today so far, whole (hourly and lines included). */
  today: DayStats;
  /** Yesterday up to the same clock time as now (totals only are read). */
  yesterdaySoFar: DayTotals;
  /** The whole of yesterday. */
  yesterday: DayStats;
  /** Totals of the older days the forecast may average over. */
  closed: ReadonlyMap<string, DayLines>;
}

/** The report from aggregated days: O(hours + items), no orders to walk. */
export function reportFromDays(days: ReportDays, now: number, timeZone: string): Report {
  const day = localTime(now, timeZone).day;
  const hourlyBuckets = days.today.hourly.map((b, hour): HourBucket => ({ hour, ...b }));
  const stats = new Map<string, ItemStat>();
  for (const l of days.today.lines) {
    const e = stats.get(l.itemId) ?? { itemId: l.itemId, name: l.name, qty: 0, orderedMinor: 0 };
    e.qty += l.qty;
    e.orderedMinor += l.orderedMinor;
    stats.set(l.itemId, e);
  }
  const all = [...stats.values()];
  const byName = (a: ItemStat, b: ItemStat) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const today = totalsOf(days.today);
  const yesterdaySoFar = totalsOf(days.yesterdaySoFar as DayStats);
  const byDay = new Map<string, DayLines>(days.closed);
  byDay.set(day, days.today);
  byDay.set(addDays(day, -1), days.yesterday);
  const base = {
    day,
    totals: today,
    hourly: hourlyBuckets,
    peak: peakHour(hourlyBuckets),
    popular: {
      byQty: [...all].sort((a, b) => b.qty - a.qty || b.orderedMinor - a.orderedMinor || byName(a, b)),
      byValue: [...all].sort((a, b) => b.orderedMinor - a.orderedMinor || b.qty - a.qty || byName(a, b)),
    },
    comparison: {
      today,
      yesterdaySoFar,
      yesterday: totalsOf(days.yesterday),
      ordersChangePct: changePct(today.orders, yesterdaySoFar.orders),
      receivedChangePct: changePct(today.receivedMinor, yesterdaySoFar.receivedMinor),
    },
    forecast: forecastFromDays(byDay, now, timeZone),
  };
  return { ...base, summary: summarize(base) };
}

/** The facts worth a sentence, in the order the dashboard reads them out; plain rules, no model. */
export function summarize(r: Omit<Report, "summary">): SummaryFact[] {
  const facts: SummaryFact[] = [];
  if (r.totals.orders === 0 && r.totals.receivedMinor === 0) facts.push({ kind: "none" });
  else {
    const { orders, orderedMinor, receivedMinor, awaitingOrders, awaitingMinor } = r.totals;
    facts.push({ kind: "orders", orders, orderedMinor, receivedMinor, awaitingOrders, awaitingMinor });
    const pct = r.comparison.ordersChangePct;
    if (pct !== null) {
      const direction = pct >= FLAT_PCT ? "up" : pct <= -FLAT_PCT ? "down" : "flat";
      facts.push({ kind: "trend", direction, ordersChangePct: pct, receivedChangePct: r.comparison.receivedChangePct });
    }
    if (r.peak !== null) facts.push({ kind: "peak", hour: r.peak.hour, orders: r.peak.orders });
    const top = r.popular.byQty[0];
    if (top !== undefined) facts.push({ kind: "top", name: top.name, qty: top.qty });
    const topValue = r.popular.byValue[0];
    if (topValue !== undefined && topValue.itemId !== top?.itemId) {
      facts.push({ kind: "topValue", name: topValue.name, orderedMinor: topValue.orderedMinor });
    }
  }
  const f = r.forecast;
  if (f.basis !== "none") {
    facts.push({ kind: "forecast", day: f.day, orders: f.orders, lines: f.lines.slice(0, 3), basis: f.basis });
  }
  return facts;
}

/**
 * Today's report as of `now` from sales: `sales` should reach back 4 weeks (the forecast), or back only to
 * `historyStart` with the older days' totals in `closed`. The app builds the same report from SQL aggregates instead
 * (`Store.dayStats`, D-044); both give the same numbers.
 */
export function dailyReport(
  sales: readonly Sale[],
  now: number,
  timeZone: string,
  closed: ReadonlyMap<string, DayLines> = new Map(),
): Report {
  const t = localTime(now, timeZone);
  const yesterday = addDays(t.day, -1);
  return reportFromDays(
    {
      today: statsFromSales(sales, t.day, timeZone),
      yesterdaySoFar: statsFromSales(sales, yesterday, timeZone, minutes(t)),
      yesterday: statsFromSales(sales, yesterday, timeZone),
      closed: new Map([...closed, ...dayLinesOf(sales, timeZone)]),
    },
    now,
    timeZone,
  );
}

/** How far back `dailyReport` reads: the forecast's 4 weeks plus today. */
export const REPORT_HISTORY_DAYS = FORECAST_WEEKS * 7 + 1;
