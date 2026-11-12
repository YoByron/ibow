/** Pure helpers of the owner's dashboard: summary sentences, the hourly chart's geometry, hour and day labels. */

import type { HourBucket, SummaryFact } from "../core/insights.ts";
import type { Payment } from "../core/payments.ts";
import { t, tn } from "./owner-strings.ts";

export interface Formatters {
  money: (minor: number) => string;
  hour: (hour: number) => string;
  day: (day: string) => string;
}

/** A business-local hour (0 to 23) as the reader's locale writes a time: `5 PM`, `17:00`. */
export function hourLabel(hour: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", timeZone: "UTC" }).format(Date.UTC(2000, 0, 1, hour));
}

/** A `YYYY-MM-DD` calendar day as the reader's locale writes it, with its weekday: `Fri, Nov 27`. */
export function dayLabel(day: string, locale?: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(
    Date.UTC(y, m - 1, d),
  );
}

function signed(pct: number): string {
  return `${pct > 0 ? "+" : ""}${pct}`;
}

/** One sentence per fact of the rule-based summary. */
export function summaryText(fact: SummaryFact, f: Formatters): string {
  switch (fact.kind) {
    case "none":
      return t("sumNone");
    case "orders": {
      const text = tn("sumOrders", fact.orders, {
        orders: String(fact.orders),
        ordered: f.money(fact.orderedMinor),
        received: f.money(fact.receivedMinor),
      });
      if (fact.awaitingOrders === 0) return text;
      const amount = f.money(fact.awaitingMinor);
      const awaiting = tn("sumAwaiting", fact.awaitingOrders, { n: String(fact.awaitingOrders), amount });
      return `${text} ${awaiting}`;
    }
    case "trend": {
      const pct = String(Math.abs(fact.ordersChangePct));
      const orders =
        fact.direction === "up"
          ? t("sumUp", { pct })
          : fact.direction === "down"
            ? t("sumDown", { pct })
            : t("sumFlat", { pct: signed(fact.ordersChangePct) });
      if (fact.receivedChangePct === null) return orders;
      return `${orders} ${t("sumReceivedTrend", { pct: signed(fact.receivedChangePct) })}`;
    }
    case "peak":
      return tn("sumPeak", fact.orders, { hour: f.hour(fact.hour), orders: String(fact.orders) });
    case "top":
      return t("sumTop", { name: fact.name, qty: String(fact.qty) });
    case "topValue":
      return t("sumTopValue", { name: fact.name, amount: f.money(fact.orderedMinor) });
    case "forecast": {
      const items = fact.lines
        .map((l) => t("qtyName", { qty: String(l.qty), name: l.size === undefined ? l.name : `${l.name} ${l.size}` }))
        .join(", ");
      const text = tn("sumForecast", fact.orders, { day: f.day(fact.day), orders: String(fact.orders), items });
      return fact.basis === "recent" ? `${text} ${t("sumForecastRecent")}` : text;
    }
  }
}

export interface Bar {
  hour: number;
  orders: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Bars for the hours from the first to the last with orders (all 24 when there are none), scaled to the busiest hour,
 * in a `width` × `height` box with a 1-unit gap between bars. An empty hour gets a zero-height bar.
 */
export function chartBars(buckets: readonly HourBucket[], width: number, height: number): Bar[] {
  const busy = buckets.filter((b) => b.orders > 0);
  const first = busy[0]?.hour ?? 0;
  const last = busy.at(-1)?.hour ?? 23;
  const shown = buckets.filter((b) => b.hour >= first && b.hour <= last);
  const max = Math.max(1, ...shown.map((b) => b.orders));
  const slot = width / shown.length;
  return shown.map((b, i) => {
    const h = (b.orders / max) * height;
    return { hour: b.hour, orders: b.orders, x: i * slot, y: height - h, width: Math.max(1, slot - 1), height: h };
  });
}

export interface PaymentBadge {
  /** `paid` only when confirmed money covers the order (D-007); a claim is never paid. */
  kind: "unpaid" | "claimed" | "paid" | "due";
  text: string;
}

/** What an order card says about the money: not paid, claimed by the customer, paid, or paid with more due. */
export function paymentBadge(
  o: { payment: Payment; outstandingMinor: number },
  money: (minor: number) => string,
): PaymentBadge {
  const p = o.payment;
  if (p.state === "unpaid") return { kind: "unpaid", text: t("notPaid") };
  if (p.state === "claimed") return { kind: "claimed", text: t("claimedLabel", { amount: money(p.amountMinor) }) };
  if (o.outstandingMinor > 0) {
    return { kind: "due", text: t("paidDueLabel", { amount: money(p.amountMinor), due: money(o.outstandingMinor) }) };
  }
  return { kind: "paid", text: t("paidLabel", { amount: money(p.amountMinor) }) };
}

/**
 * What the order tabs, showing `listDay`, do with an event for an order placed on `orderDay` (both business-local):
 * show it, reload the tabs for the new day once midnight has passed, or leave out a late change to an earlier day.
 */
export function orderEventAction(listDay: string, orderDay: string): "apply" | "reload" | "ignore" {
  if (orderDay === listDay) return "apply";
  return orderDay > listDay ? "reload" : "ignore";
}

/** The badge for a returning customer, or nothing for a first visit. */
export function returningText(visits: number | undefined): string | undefined {
  if (visits === undefined || visits < 1) return undefined;
  return tn("returning", visits, { n: String(visits) });
}

/**
 * Axis marks for a chart whose tallest bar is `max`: zero and a few round numbers (1, 2, 5, 10, 20, 50 … per step)
 * up to the first one at or above `max`, so the top bar never pokes through the top line.
 */
export function axisTicks(max: number): number[] {
  const top = Math.max(1, Math.ceil(max));
  const raw = top / 3;
  const base = Math.max(1, 10 ** Math.floor(Math.log10(raw)));
  const step = ([1, 2, 5, 10].map((m) => m * base).find((s) => s >= raw) ?? top) || 1;
  const ticks: number[] = [];
  for (let n = 0; n < top + step; n += step) {
    ticks.push(n);
    if (n >= top) break;
  }
  return ticks;
}
