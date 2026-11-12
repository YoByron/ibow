/**
 * M7 checkpoint, the analyst half: a fixed set of owner questions, answered through the real model door by a fake
 * Chat Completions server that reads the figures it was sent and answers with one of them. Each answer must carry
 * the rule-based number (`dailyReport` and `dayTotals` over the same sales) and cite the figure it came from. The
 * number check flags anything the figures don't back.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ANALYST_SYSTEM, analystContext, analystPrompt, ask } from "../src/ai/analyst.ts";
import { openModel } from "../src/ai/index.ts";
import type { ChatModel } from "../src/ai/model.ts";
import { addDays, dailyReport, dayTotals, localTime, type Sale, saleOf } from "../src/core/insights.ts";
import { majorAmount } from "../src/core/money.ts";
import { createOrder, type Order } from "../src/core/orders.ts";
import { claimPayment, confirmPayment } from "../src/core/payments.ts";
import { analystRequest, chat, type FakeModel, startFakeModel } from "./support/fake-model.ts";
import type { Rush } from "./support/rush.ts";
import { loadSample, readSample } from "./support/samples.ts";

const DAY = 86_400_000;
const SAMPLE = "tea-house";
const config = loadSample(SAMPLE);
const { timeZone, currency } = config.business;
const rush = readSample(SAMPLE, "rush.json") as Rush;
/** 19:15 in the tea house's zone, a quarter of an hour after its rush. */
const now = Date.UTC(2026, 10, 26, 13, 45);

/** The rush today (a mix of confirmed, claimed and unpaid), half of it yesterday and a third of it six days ago. */
function sales(): Sale[] {
  const days: [number, (i: number) => boolean][] = [
    [0, () => true],
    [-1, (i) => i % 2 === 0],
    [-6, (i) => i % 3 === 0],
  ];
  return days.flatMap(([shift, keep]) =>
    rush.orders.flatMap((o, i) => {
      if (!keep(i)) return [];
      const at = o.at + shift * DAY;
      let order: Order = createOrder(config, { id: `a${shift}-${i}`, token: `t-${i}`, now: at, lines: o.lines });
      const total = order.lines.reduce((n, l) => n + l.qty * l.unitMinor, 0);
      if (i % 3 === 0) {
        order = {
          ...order,
          payment: confirmPayment(order.payment, { by: "c1", method: "cash", amountMinor: total, now: at + 30_000 }),
        };
      } else if (i % 3 === 1) {
        order = { ...order, payment: claimPayment(order.payment, { method: "upi", amountMinor: total, now: at }) };
      }
      return [saleOf(order)];
    }),
  );
}

const all = sales();
const report = dailyReport(all, now, timeZone);
const today = localTime(now, timeZone).day;
const money = (minor: number) => majorAmount(minor, currency);
const last7Orders = Array.from({ length: 7 }, (_, i) => dayTotals(all, addDays(today, -i), timeZone).orders).reduce(
  (a, b) => a + b,
);

/** Question, the figure a correct answer uses, and the rule-based number it must state. */
const QUESTIONS: [string, string, string][] = [
  ["How many orders have we had today?", "today.orders", String(report.totals.orders)],
  ["How much money have we received today?", "today.received", money(report.totals.receivedMinor)],
  ["What is the value of the orders placed today?", "today.ordered", money(report.totals.orderedMinor)],
  ["How much is still awaiting payment confirmation?", "today.awaitingAmount", money(report.totals.awaitingMinor)],
  ["What was our busiest hour today?", "today.peakHour", `${report.peak?.hour}:00`],
  ["What sold the most today?", "today.mostOrdered.1", String(report.popular.byQty[0]?.qty)],
  ["How many orders did we have yesterday?", "yesterday.orders", String(report.comparison.yesterday.orders)],
  ["How many orders were placed over the last week?", "last7.orders", String(last7Orders)],
  ["How many orders should we prepare for tomorrow?", "forecast.orders", String(report.forecast.orders)],
];

/** The fake analyst: finds the figure the question is about and states it, citing its key. */
function scripted(question: string, figures: { key: string; value: string; label?: string }[]): string {
  const key = QUESTIONS.find(([q]) => q === question)?.[1];
  const f = figures.find((x) => x.key === key);
  return f === undefined ? "I don't have that figure." : `The figure is ${f.value} [${f.key}].`;
}

let fake: FakeModel;
let model: ChatModel;
beforeAll(async () => {
  fake = await startFakeModel((req) => {
    const { question, figures } = analystRequest(req);
    return chat(scripted(question, figures as { key: string; value: string; label: string }[]));
  });
  model = openModel({ AI_BASE_URL: fake.baseUrl, AI_MODEL: "fake" }) as ChatModel;
});
afterAll(() => fake.close());

describe("the fixed question set", () => {
  test("the fixture has every kind of money and a same-weekday forecast", () => {
    expect(report.totals.orders).toBe(300);
    expect(report.totals.receivedMinor).toBeGreaterThan(0);
    expect(report.totals.awaitingMinor).toBeGreaterThan(0);
    expect(report.totals.orderedMinor).toBeGreaterThan(report.totals.receivedMinor);
    expect(report.forecast.basis).toBe("same-weekday");
    expect(last7Orders).toBe(300 + 150 + 100);
  });

  test.each(QUESTIONS)("%s → the rule-based %s, cited", async (question, key, expected) => {
    const ctx = analystContext(all, now, timeZone, currency);
    const answer = await ask(model, question, ctx);
    expect(answer.grounded, `${answer.text} ${answer.unverified}`).toBe(true);
    expect(answer.figures.map((f) => f.key)).toEqual([key]);
    expect(answer.figures[0]?.value).toBe(expected);
    expect(answer.text).toContain(`${expected} [${key}]`);
  });

  test("the model is told the rules and gets only the figures and the question", async () => {
    fake.seen.length = 0;
    await ask(model, "How many orders have we had today?", analystContext(all, now, timeZone, currency));
    const body = fake.seen[0]?.body;
    expect(body.messages[0]).toEqual({ role: "system", content: ANALYST_SYSTEM });
    expect(ANALYST_SYSTEM).toMatch(/Never calculate/);
    expect(ANALYST_SYSTEM).toMatch(/Received is money staff confirmed/);
    expect(body.messages).toHaveLength(2);
    expect(body.max_tokens).toBeLessThanOrEqual(400);
  });
});

describe("the figures", () => {
  const ctx = analystContext(all, now, timeZone, currency);
  const label = (key: string) => ctx.figures.find((f) => f.key === key)?.label ?? "";

  test("keys are unique, and Ordered, Received and Awaiting keep their meanings (D-015)", () => {
    const keys = ctx.figures.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(label("today.ordered")).toMatch(/paid or not/);
    expect(label("today.received")).toMatch(/money staff confirmed/);
    expect(label("today.awaitingAmount")).toMatch(/not received/);
    expect(ctx.asOf).toBe(`${today} 19:15`);
  });

  test("money is in major units, as the dashboard's rules compute it", () => {
    const v = (key: string) => ctx.figures.find((f) => f.key === key)?.value;
    expect(v("today.received")).toBe(money(report.totals.receivedMinor));
    expect(v("yesterday.received")).toBe(money(report.comparison.yesterday.receivedMinor));
    expect(v(`day.${today}.orders`)).toBe("300");
  });

  test("the prompt stays small enough for a local model's default context: no empty hours, no long tails", () => {
    const prompt = ANALYST_SYSTEM + analystPrompt("How many orders have we had today?", ctx);
    expect(prompt.length).toBeLessThanOrEqual(5 * 1024);
    expect(ctx.figures.filter((f) => f.key.startsWith("today.hour.")).every((f) => f.value !== "0")).toBe(true);
    expect(ctx.figures.filter((f) => f.key.startsWith("today.mostOrdered.")).length).toBeLessThanOrEqual(3);
    expect(ctx.figures.filter((f) => f.key.startsWith("forecast.item.")).length).toBeLessThanOrEqual(5);
    // A day with no orders and nothing received is left out; the 7-day sums still cover it.
    const empty = analystContext(all, now + 3 * DAY, timeZone, currency).figures.map((f) => f.key);
    expect(empty).not.toContain(`day.${addDays(today, 3)}.orders`);
    expect(empty).toContain("last7.orders");
  });

  test("an empty history still gives figures, and says there is nothing to forecast", () => {
    const empty = analystContext([], now, timeZone, currency);
    expect(empty.figures.find((f) => f.key === "today.orders")?.value).toBe("0");
    expect(empty.figures.find((f) => f.key === "forecast.none")).toBeDefined();
  });
});

describe("the number check, end to end", () => {
  test("a model that makes a number up is caught end to end", async () => {
    const before = fake.reply;
    fake.reply = () => chat("You had 9999 orders today [today.orders].");
    const a = await ask(model, "How many orders?", analystContext(all, now, timeZone, currency));
    fake.reply = before;
    expect(a.unverified).toEqual(["9999"]);
    expect(a.grounded).toBe(false);
  });
});
