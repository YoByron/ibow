/**
 * The AI business analyst (M7, D-027): the owner asks in plain language; the answer comes from the rule-based figures.
 * Code computes every number (`src/core/insights`) and hands the model a compact list of named figures; the model
 * only picks, phrases and reasons, and cites the figure keys it used. `checkAnswer` (`grounding.ts`) then flags any
 * number in the reply that a figure cited beside it doesn't back. Only anonymous counts go in: no customer name, no
 * review text (D-016).
 */

import {
  addDays,
  type DayTotals,
  dailyReport,
  dayTotals,
  localTime,
  ordersOn,
  popularItems,
  type Report,
  type Sale,
} from "../core/insights.ts";
import { majorAmount } from "../core/money.ts";
import { checkAnswer } from "./grounding.ts";
import type { ChatModel } from "./model.ts";

export type FigureUnit = "orders" | "units" | "money" | "percent" | "hour" | "date" | "text";

/** One number (or fact) the model may use, under a key it cites as `[key]`. */
export interface Figure {
  key: string;
  label: string;
  /** As the answer must write it: money in major units of the currency (`1234.50`), hours as `18:00`. */
  value: string;
  unit: FigureUnit;
  /** What the figure is about, which an answer may name beside it: a business-local day, ... */
  date?: string;
  /** ... an hour of the day (0 to 23), ... */
  hour?: number;
  /** ... a clock time (`HH:MM`), ... */
  at?: string;
  /** ... a span of days, ... */
  days?: number;
  /** ... or an item (its catalog name, with the size). */
  item?: string;
}

/** What a figure is about, beyond its value. */
type About = Pick<Figure, "date" | "hour" | "at" | "days" | "item">;

export interface AnalystContext {
  currency: string;
  timeZone: string;
  /** Business-local `YYYY-MM-DD HH:MM` the figures were computed at. */
  asOf: string;
  figures: Figure[];
}

export interface Answer {
  /** The model's reply, as text, with its `[key]` citations. */
  text: string;
  /** The figures it cited, in the order first cited. */
  figures: Figure[];
  /** Numbers in the reply, as written, that no figure cited in their sentence backs; citations of unknown keys. */
  unverified: string[];
  /** Nothing unverified. */
  grounded: boolean;
}

/** How many days "the last days" covers: today and the six before. */
export const RECENT_DAYS = 7;
/** Long tails are left out: they rarely answer a question and cost a small model its context. */
const TOP_ITEMS = 3;
const FORECAST_ITEMS = 5;
export const MAX_QUESTION_CHARS = 500;
const MAX_ANSWER_TOKENS = 400;
const MAX_ANSWER_CHARS = 2000;

const pad = (n: number) => String(n).padStart(2, "0");
const hourText = (h: number) => `${pad(h)}:00`;

/** The figures for one question, from the same rules as the dashboard. Sales carry no customer details. */
export function analystContext(
  sales: readonly Sale[],
  now: number,
  timeZone: string,
  currency: string,
  /** The dashboard's report, if the caller has it (the app builds it in SQL); else it is computed from `sales`. */
  prepared?: Report,
): AnalystContext {
  const report = prepared ?? dailyReport(sales, now, timeZone);
  const t = localTime(now, timeZone);
  const money = (minor: number) => majorAmount(minor, currency);
  const figures: Figure[] = [];
  const add = (key: string, label: string, value: string | number, unit: FigureUnit, about: About = {}) =>
    figures.push({ key, label, value: String(value), unit, ...about });

  const day = (p: string, when: string, d: DayTotals, date: string) => {
    const put = (key: string, label: string, value: string | number, unit: FigureUnit) =>
      add(key, label, value, unit, { date });
    put(`${p}.orders`, `Orders placed ${when}`, d.orders, "orders");
    if (p === "today") put(`${p}.items`, `Units (items) in the orders placed ${when}`, d.items, "units");
    put(`${p}.ordered`, `Ordered ${when}: value of the orders placed, paid or not`, money(d.orderedMinor), "money");
    if (p === "today") put(`${p}.average`, `Average order value ${when}`, money(d.averageMinor), "money");
    put(`${p}.received`, `Received ${when}: money staff confirmed`, money(d.receivedMinor), "money");
    put(`${p}.awaitingOrders`, `Orders placed ${when} still awaiting payment confirmation`, d.awaitingOrders, "orders");
    put(
      `${p}.awaitingAmount`,
      `Awaiting confirmation: what the orders placed ${when} still owe, not received`,
      money(d.awaitingMinor),
      "money",
    );
  };
  const c = report.comparison;
  const yesterday = addDays(t.day, -1);
  const clock = `${pad(t.hour)}:${pad(t.minute)}`;
  day("today", "today", report.totals, t.day);
  day("yesterday", "yesterday (whole day)", c.yesterday, yesterday);
  add(
    "yesterdaySoFar.orders",
    `Orders placed yesterday up to ${pad(t.hour)}:${pad(t.minute)}`,
    c.yesterdaySoFar.orders,
    "orders",
    { date: yesterday, at: clock },
  );
  add(
    "yesterdaySoFar.received",
    `Received yesterday up to ${pad(t.hour)}:${pad(t.minute)}: money staff confirmed`,
    money(c.yesterdaySoFar.receivedMinor),
    "money",
    { date: yesterday, at: clock },
  );
  if (c.ordersChangePct !== null) {
    add(
      "today.ordersChangePct",
      "Change in orders, today against yesterday up to the same time (%)",
      c.ordersChangePct,
      "percent",
    );
  }
  if (c.receivedChangePct !== null) {
    add(
      "today.receivedChangePct",
      "Change in money received, today against yesterday up to the same time (%)",
      c.receivedChangePct,
      "percent",
    );
  }

  if (report.peak !== null) {
    add(
      "today.peakHour",
      "Busiest hour today by orders placed (start of the hour, business-local)",
      hourText(report.peak.hour),
      "hour",
    );
    add("today.peakOrders", "Orders placed in the busiest hour today", report.peak.orders, "orders");
  }
  for (const b of report.hourly) {
    if (b.orders > 0)
      add(
        `today.hour.${pad(b.hour)}`,
        `Orders placed today from ${hourText(b.hour)} to ${pad(b.hour)}:59`,
        b.orders,
        "orders",
        { hour: b.hour },
      );
  }
  report.popular.byQty.slice(0, TOP_ITEMS).forEach((s, i) => {
    add(`today.mostOrdered.${i + 1}`, `Most ordered today, rank ${i + 1}: ${s.name} (units)`, s.qty, "units", {
      item: s.name,
    });
  });
  report.popular.byValue.slice(0, TOP_ITEMS).forEach((s, i) => {
    add(
      `today.topByValue.${i + 1}`,
      `Top item by order value today, rank ${i + 1}: ${s.name}`,
      money(s.orderedMinor),
      "money",
      { item: s.name },
    );
  });

  let orders = 0;
  let ordered = 0;
  let received = 0;
  const recent: Sale[] = [];
  for (let i = RECENT_DAYS - 1; i >= 0; i--) {
    const d = addDays(t.day, -i);
    const totals = dayTotals(sales, d, timeZone);
    orders += totals.orders;
    ordered += totals.orderedMinor;
    received += totals.receivedMinor;
    recent.push(...ordersOn(sales, d, timeZone));
    // A day with no orders and no money received is left out; the 7-day sums below still count it.
    if (totals.orders === 0 && totals.receivedMinor === 0) continue;
    add(`day.${d}.orders`, `Orders placed on ${d}`, totals.orders, "orders", { date: d });
    add(
      `day.${d}.ordered`,
      `Ordered on ${d}: value of the orders placed, paid or not`,
      money(totals.orderedMinor),
      "money",
      { date: d },
    );
    add(`day.${d}.received`, `Received on ${d}: money staff confirmed`, money(totals.receivedMinor), "money", {
      date: d,
    });
  }
  const span = `the last ${RECENT_DAYS} days (${addDays(t.day, 1 - RECENT_DAYS)} to ${t.day})`;
  const week = { days: RECENT_DAYS };
  add("last7.orders", `Orders placed in ${span}`, orders, "orders", week);
  add("last7.ordered", `Ordered in ${span}: value of the orders placed, paid or not`, money(ordered), "money", week);
  add("last7.received", `Received in ${span}: money staff confirmed`, money(received), "money", week);
  popularItems(recent)
    .byQty.slice(0, TOP_ITEMS)
    .forEach((s, i) => {
      add(`last7.mostOrdered.${i + 1}`, `Most ordered in ${span}, rank ${i + 1}: ${s.name} (units)`, s.qty, "units", {
        ...week,
        item: s.name,
      });
    });

  const f = report.forecast;
  if (f.basis === "none")
    add("forecast.none", "Prep forecast for tomorrow", "no order history to forecast from yet", "text");
  else {
    add("forecast.day", "The day the prep forecast is for", f.day, "date");
    add(
      "forecast.basis",
      "How the prep forecast is made",
      f.basis === "same-weekday"
        ? "mean of the same weekday over the last 4 weeks, days with orders only, rounded up"
        : "mean of the last 7 days with orders, rounded up",
      "text",
    );
    add("forecast.basisDays", "The days the prep forecast is the mean of", f.basisDays.join(", "), "date");
    add("forecast.orders", `Orders expected on ${f.day}`, f.orders, "orders", { date: f.day });
    f.lines.slice(0, FORECAST_ITEMS).forEach((l, i) => {
      const name = l.size === undefined ? l.name : `${l.name} (${l.size})`;
      add(`forecast.item.${i + 1}`, `Prep for ${f.day}, rank ${i + 1}: ${name} (units)`, l.qty, "units", {
        date: f.day,
        item: name,
      });
    });
  }
  return { currency, timeZone, asOf: `${t.day} ${pad(t.hour)}:${pad(t.minute)}`, figures };
}

/** The standing instructions: figures only, cite them, keep Ordered and Received apart (D-015). */
export const ANALYST_SYSTEM = [
  "You are the business analyst for one small business, answering its owner.",
  "Answer only from the figures in the user's message. Rules:",
  "1. Copy every number exactly as a figure's value writes it. Never calculate, add, estimate, round or convert a number. If the question needs a number that is not among the figures, say that figure isn't available.",
  "2. After each sentence that uses a figure, cite its key in square brackets, like [today.orders].",
  "3. Ordered is the value of orders placed, paid or not. Received is money staff confirmed. Awaiting confirmation is money not confirmed yet. Never call Ordered money received or income.",
  "4. Money is in the currency given, in major units. Hours are the business's local time, 24-hour.",
  "5. At most four short sentences, plain text, no markdown, in the language of the question.",
].join("\n");

/**
 * The user message: one header line, then one line per figure (`key | meaning | value`), then the question. Plain
 * lines, not JSON, and without the attributes only the number check reads: about half the size, which matters for a
 * small local model's context window.
 */
export function analystPrompt(question: string, ctx: AnalystContext): string {
  return [
    `Money in ${ctx.currency}, major units. Time zone ${ctx.timeZone}. Now ${ctx.asOf}.`,
    "Figures (key | meaning | value):",
    ...ctx.figures.map((f) => `${f.key} | ${f.label} | ${f.value}`),
    "",
    `Question: ${question.replace(/\s+/g, " ").trim()}`,
  ].join("\n");
}

/** One question to the model over `ctx`; throws `AiError` when the model fails. */
export async function ask(model: ChatModel, question: string, ctx: AnalystContext): Promise<Answer> {
  const reply = await model.complete({
    system: ANALYST_SYSTEM,
    user: analystPrompt(question, ctx),
    maxTokens: MAX_ANSWER_TOKENS,
  });
  return checkAnswer(reply.slice(0, MAX_ANSWER_CHARS), ctx);
}
