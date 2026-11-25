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

import type { Order, OrderLine } from "../../src/core/orders.ts";
import type { PaymentMethod } from "../../src/core/payments.ts";

/** Money a person confirmed for an order: the confirmation and each top-up, at the time each was confirmed. */
export interface Receipt {
  amountMinor: number;
  at: number;
  method?: PaymentMethod | undefined;
}

/** What insights read of an order: when, its lines and the money confirmed for it. No name. */
export interface Sale {
  createdAt: number;
  lines: readonly Pick<OrderLine, "itemId" | "name" | "size" | "qty" | "unitMinor">[];
  received: readonly Receipt[];
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
    );
  }
  return { createdAt: order.createdAt, lines: order.lines, received };
}

export interface LocalTime {
  /** `YYYY-MM-DD` in the business time zone. */
  day: string;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The business-local date and clock time of an instant. */
export function localTime(at: number, timeZone: string): LocalTime {
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
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
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
  let awaitingOrders = 0;
  let awaitingMinor = 0;
  for (const s of sales) {
    for (const r of s.received) {
      if (!within(r.at)) continue;
      receivedMinor += r.amountMinor;
      if (r.method === "cash") receivedCashMinor += r.amountMinor;
      else if (r.method === "upi") receivedUpiMinor += r.amountMinor;
    }
    if (!within(s.createdAt)) continue;
    const value = total(s);
    orders++;
    items += units(s);
    orderedMinor += value;
    const owed = value - s.received.reduce((n, r) => n + r.amountMinor, 0);
    if (owed > 0) {
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
    receivedCardMinor: 0,
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

/**
 * Tomorrow's prep (D-015): for each item and size, the mean units ordered on the same weekday over the last 4 weeks,
 * counting only those days that had orders (a day the business was shut says nothing about demand). With none, the
 * mean over the last 7 days that had orders. Means are rounded up.
 */
export function prepForecast(orders: readonly Sale[], now: number, timeZone: string): Forecast {
  const today = localTime(now, timeZone).day;
  const target = addDays(today, 1);
  const byDay = new Map<string, Sale[]>();
  for (const o of orders) {
    const day = localTime(o.createdAt, timeZone).day;
    if (day > today) continue;
    byDay.set(day, [...(byDay.get(day) ?? []), o]);
  }
  const weekdays = Array.from({ length: FORECAST_WEEKS }, (_, i) => addDays(target, -7 * (i + 1))).filter((d) =>
    byDay.has(d),
  );
  let basis: Forecast["basis"] = "same-weekday";
  let basisDays = weekdays;
  if (basisDays.length === 0) {
    basis = "recent";
    basisDays = Array.from({ length: RECENT_DAYS }, (_, i) => addDays(today, -i)).filter((d) => byDay.has(d));
  }
  if (basisDays.length === 0) return { day: target, basis: "none", basisDays: [], orders: 0, lines: [] };

  const n = basisDays.length;
  const sums = new Map<string, ForecastLine>();
  let orderCount = 0;
  for (const day of basisDays) {
    for (const o of byDay.get(day) as Sale[]) {
      orderCount++;
      for (const l of o.lines) {
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
  }
  const lines = [...sums.values()]
    .map((s) => ({ ...s, qty: Math.ceil(s.qty / n) }))
    .sort(
      (a, b) =>
        b.qty - a.qty || (a.name < b.name ? -1 : a.name > b.name ? 1 : (a.size ?? "") < (b.size ?? "") ? -1 : 1),
    );
  return { day: target, basis, basisDays: [...basisDays].sort(), orders: Math.ceil(orderCount / n), lines };
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

/** Today's report as of `now`, from orders reaching back at least 4 weeks (for the forecast). */
export function dailyReport(sales: readonly Sale[], now: number, timeZone: string): Report {
  const day = localTime(now, timeZone).day;
  const todays = ordersOn(sales, day, timeZone);
  const buckets = hourly(todays, day, timeZone);
  const base = {
    day,
    totals: dayTotals(sales, day, timeZone),
    hourly: buckets,
    peak: peakHour(buckets),
    popular: popularItems(todays),
    comparison: compareWithYesterday(sales, now, timeZone),
    forecast: prepForecast(sales, now, timeZone),
  };
  return { ...base, summary: summarize(base) };
}

/** How far back `dailyReport` reads: the forecast's 4 weeks plus today. */
export const REPORT_HISTORY_DAYS = FORECAST_WEEKS * 7 + 1;
