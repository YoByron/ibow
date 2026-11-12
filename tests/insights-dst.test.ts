/** Insights on the two New York days the clocks change: hours and day edges come from the zone, not a fixed offset. */

import { describe, expect, test } from "vitest";
import { compareWithYesterday, dayTotals, hourly, localTime, saleOf } from "../src/core/insights.ts";
import { createOrder } from "../src/core/orders.ts";
import { loadSample } from "./support/samples.ts";

const config = loadSample("coffee-cart");
const tz = config.business.timeZone; // America/New_York
let n = 0;
const sale = (at: number) =>
  saleOf(
    createOrder(config, { id: `d${++n}`, token: `t${n}`, now: at, lines: [{ itemId: "espresso", size: "S", qty: 1 }] }),
  );
const utc = (m: number, d: number, h: number, min = 0) => Date.UTC(2026, m - 1, d, h, min);

describe("insights across New York's clock changes", () => {
  test("2026-11-01, clocks back: both 01:30s share hour 1, and the day runs 04:00Z to 05:00Z next day (25 hours)", () => {
    const first = utc(11, 1, 5, 30); // 01:30 EDT
    const second = utc(11, 1, 6, 30); // 01:30 EST, an hour later
    expect(localTime(first, tz)).toEqual({ day: "2026-11-01", hour: 1, minute: 30 });
    expect(localTime(second, tz)).toEqual({ day: "2026-11-01", hour: 1, minute: 30 });
    const sales = [
      sale(utc(11, 1, 3, 59)), // 23:59 EDT on 31 October
      sale(utc(11, 1, 4, 0)), // 00:00 EDT, the day's first minute
      sale(first),
      sale(second),
      sale(utc(11, 2, 4, 59)), // 23:59 EST, the day's last minute
      sale(utc(11, 2, 5, 0)), // 00:00 EST on 2 November
    ];
    const buckets = hourly(sales, "2026-11-01", tz);
    expect(buckets[0]?.orders).toBe(1);
    expect(buckets[1]?.orders).toBe(2);
    expect(buckets[23]?.orders).toBe(1);
    expect(buckets.reduce((s, b) => s + b.orders, 0)).toBe(4);
    expect(dayTotals(sales, "2026-11-01", tz)).toMatchObject({ orders: 4, orderedMinor: 1200 });
    expect(dayTotals(sales, "2026-10-31", tz).orders).toBe(1);
    expect(dayTotals(sales, "2026-11-02", tz).orders).toBe(1);
  });

  test("2026-03-08, clocks forward: hour 2 never happens, and the day runs 05:00Z to 04:00Z next day (23 hours)", () => {
    const sales = [
      sale(utc(3, 8, 4, 59)), // 23:59 EST on 7 March
      sale(utc(3, 8, 5, 0)), // 00:00 EST
      sale(utc(3, 8, 6, 59)), // 01:59 EST
      sale(utc(3, 8, 7, 0)), // 03:00 EDT, the minute after
      sale(utc(3, 9, 3, 59)), // 23:59 EDT
      sale(utc(3, 9, 4, 0)), // 00:00 EDT on 9 March
    ];
    expect(localTime(utc(3, 8, 7, 0), tz)).toEqual({ day: "2026-03-08", hour: 3, minute: 0 });
    const buckets = hourly(sales, "2026-03-08", tz);
    expect(buckets.map((b) => b.orders).slice(0, 4)).toEqual([1, 1, 0, 1]);
    expect(buckets[23]?.orders).toBe(1);
    expect(dayTotals(sales, "2026-03-08", tz).orders).toBe(4);
    expect(dayTotals(sales, "2026-03-07", tz).orders).toBe(1);
    expect(dayTotals(sales, "2026-03-09", tz).orders).toBe(1);
    // At 03:30 EDT on the 9th, yesterday by this time is everything on the 8th up to 03:30: three orders.
    const c = compareWithYesterday(sales, utc(3, 9, 7, 30), tz);
    expect(c.yesterdaySoFar.orders).toBe(3);
    expect(c.today.orders).toBe(1);
  });
});
