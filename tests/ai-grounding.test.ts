/**
 * M7 review: an answer's numbers are backed only by the figures cited in the same sentence, by unit. A real figure
 * passed off as another (Ordered as Received, yesterday as today), a flipped sign or a stray small number is flagged;
 * honest wording (grouping, currency symbols, 12-hour clocks, dates the figure is about) passes.
 */

import { describe, expect, test } from "vitest";
import type { AnalystContext } from "../src/ai/analyst.ts";
import { checkAnswer } from "../src/ai/grounding.ts";

const ctx: AnalystContext = {
  currency: "INR",
  timeZone: "Asia/Kolkata",
  asOf: "2026-11-09 19:15",
  figures: [
    { key: "today.orders", label: "Orders placed today", value: "300", unit: "orders" },
    { key: "today.ordered", label: "Ordered today (INR)", value: "71680.00", unit: "money" },
    { key: "today.received", label: "Received today (INR)", value: "22875.00", unit: "money" },
    { key: "today.awaitingAmount", label: "Awaiting (INR)", value: "1500.50", unit: "money" },
    { key: "yesterday.received", label: "Received yesterday (INR)", value: "11000.00", unit: "money" },
    { key: "today.ordersChangePct", label: "Change in orders (%)", value: "-12", unit: "percent" },
    { key: "today.receivedChangePct", label: "Change in received (%)", value: "8", unit: "percent" },
    { key: "today.peakHour", label: "Busiest hour today", value: "18:00", unit: "hour" },
    { key: "today.hour.17", label: "Orders 17:00 to 17:59", value: "42", unit: "orders", hour: 17 },
    { key: "yesterdaySoFar.orders", label: "Orders yesterday so far", value: "341", unit: "orders", at: "19:15" },
    { key: "day.2026-11-03.orders", label: "Orders on 2026-11-03", value: "40", unit: "orders", date: "2026-11-03" },
    { key: "last7.orders", label: "Orders in the last 7 days", value: "550", unit: "orders", days: 7 },
    {
      key: "today.topByValue.1",
      label: "Top item by value",
      value: "1960.00",
      unit: "money",
      item: "Cold Rose Tea 500ml",
    },
    { key: "forecast.day", label: "Forecast for", value: "2026-11-10", unit: "date" },
  ],
};

const flagged = (text: string) => checkAnswer(text, ctx).unverified;

describe("a real figure passed off as another is flagged", () => {
  test("Ordered stated as Received (D-015)", () => {
    expect(flagged("You received 71680 today [today.received].")).toEqual(["71680"]);
    expect(flagged("You received ₹71,680.00 today [today.received] [today.orders].")).toEqual(["71,680.00"]);
  });

  test("yesterday's Received stated as today's", () => {
    expect(flagged("Today you received 11000.00 [today.received].")).toEqual(["11000.00"]);
    expect(flagged("Yesterday you received 22875.00 [yesterday.received].")).toEqual(["22875.00"]);
  });

  test("a number backed only by a figure cited in another sentence", () => {
    expect(flagged("You had 300 orders. Received was 22875.00 [today.received].")).toEqual(["300"]);
  });

  test("a flipped sign", () => {
    expect(flagged("Orders are up 12% on yesterday [today.ordersChangePct].")).toEqual(["12%"]);
    expect(flagged("Orders rose 12 percent [today.ordersChangePct].")).toEqual(["12 percent"]);
    expect(flagged("Received is down 8% [today.receivedChangePct].")).toEqual(["8%"]);
    expect(flagged("Orders changed 12% [today.ordersChangePct].")).toEqual(["12%"]);
  });

  test("a stray small number, and a money value with more decimals than the currency has", () => {
    expect(flagged("You had 300 orders in 3 hours [today.orders].")).toEqual(["3"]);
    expect(flagged("The top item sold 1960.005 [today.topByValue.1].")).toEqual(["1960.005"]);
    expect(flagged("The busiest hour was 7 PM [today.peakHour].")).toEqual(["7 PM"]);
  });

  test("numbers in words and in other scripts can't be checked, so they are flagged", () => {
    expect(flagged("You had three hundred orders [today.orders].")).toEqual(["three", "hundred"]);
    expect(flagged("आज ३०० ऑर्डर [today.orders]।")).toEqual(["३००"]);
    expect(flagged("Twice as many as yesterday [today.orders].")).toEqual(["Twice"]);
  });

  test("an unknown citation, and numbers with no citation at all", () => {
    expect(flagged("You had 300 orders [today.orders] [made.up].")).toEqual(["[made.up]"]);
    const a = checkAnswer("You had 300 orders.", ctx);
    expect(a.unverified).toEqual(["300"]);
    expect(a.grounded).toBe(false);
  });
});

describe("honest answers pass", () => {
  test.each([
    "The top item by value brought in ₹1,960.00 [today.topByValue.1].",
    "Cold Rose Tea 500ml brought in 1960 [today.topByValue.1].",
    "Still awaiting confirmation: 1,500.5 [today.awaitingAmount].",
    "On 2026-11-03 you had 40 orders [day.2026-11-03.orders].",
    "The busiest hour was 6 PM [today.peakHour].",
    "The busiest hour started at 18:00 [today.peakHour].",
    "From 17:00 to 17:59 you had 42 orders [today.hour.17].",
    "By 19:15 yesterday you had 341 orders [yesterdaySoFar.orders].",
    "Over the last 7 days, 550 orders were placed [last7.orders].",
    "Orders are down 12% [today.ordersChangePct], while received is up 8% [today.receivedChangePct].",
    "Orders: -12% against yesterday [today.ordersChangePct].",
    "That is 12% fewer orders than yesterday by now [today.ordersChangePct].",
    "You had 300 orders today. [today.orders]",
    "The forecast is for 2026-11-10 [forecast.day].",
    "You have received 22875.00 so far [today.received]; 71680.00 was ordered [today.ordered].",
    "I don't have that figure.",
  ])("%s", (text) => {
    const a = checkAnswer(text, ctx);
    expect(a.unverified).toEqual([]);
    expect(a.grounded).toBe(true);
  });

  test("the figures cited are returned in the order first cited", () => {
    const a = checkAnswer("Ordered 71680.00 [today.ordered]. Received 22875.00 [today.received] [today.ordered].", ctx);
    expect(a.figures.map((f) => f.key)).toEqual(["today.ordered", "today.received"]);
  });
});
