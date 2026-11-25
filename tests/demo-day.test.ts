import { describe, expect, test } from "vitest";
import { upcoming } from "../src/core/calendar.ts";
import { localTime } from "../src/core/insights.ts";
import { openRoomOrders } from "../src/core/rooms.ts";
import { instantOn } from "../src/demo/clock.ts";
import { type DemoRush, SEEDED_UNTIL, seedDemo, topUpDemo } from "../src/demo/seed.ts";
import { createReportBuilder } from "../src/server/report.ts";
import { openStore } from "../src/store/node.ts";
import type { Store } from "../src/store/store.ts";
import { loadSample, readSample } from "./support/samples.ts";

const config = loadSample("garden-cafe");
const rush = readSample("garden-cafe", "rush.json") as DemoRush;
const zone = config.business.timeZone;
/** Wednesday 2 December 2026 at 15:30 in Lisbon: the cafe has been open since 09:00. */
const NOW = instantOn(zone, Date.UTC(2026, 11, 2, 12), 15, 30);
const DAY = 86_400_000;

function seeded(now = NOW): Store {
  const store = openStore(":memory:");
  store.useTimeZone(zone);
  seedDemo(store, { config, rush, now, upi: false });
  return store;
}

const ordersOn = (store: Store, at: number) => store.ordersOnDay(localTime(at, zone).day);
const report = (store: Store, at: number) => createReportBuilder(store, zone)(at);

describe("the demo's today (D-086)", { timeout: 120_000 }, () => {
  test("today holds the orders up to now, shaped like yesterday at the same time, never a near-empty day", () => {
    const store = seeded();
    const today = ordersOn(store, NOW);
    const sameTimeYesterday = ordersOn(store, NOW - DAY).filter((o) => o.createdAt <= NOW - DAY);
    expect(today.length).toBeGreaterThan(100);
    expect(today.every((o) => o.createdAt <= NOW)).toBe(true);
    const ratio = today.length / sameTimeYesterday.length;
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(1.6);
    // Inside the opening hours, busiest where the profile is.
    const hours = today.map((o) => localTime(o.createdAt, zone).hour);
    expect(Math.min(...hours)).toBeGreaterThanOrEqual(9);
    expect(Math.max(...hours)).toBeLessThanOrEqual(15);
    const count = (h: number) => hours.filter((x) => x === h).length;
    expect(count(13)).toBeGreaterThan(count(15));
    store.close();
  });

  test("with a room zone, four of today's collected orders wait on room bills", () => {
    const store = seeded();
    const open = openRoomOrders(store.openRoomOrders());
    expect(open).toHaveLength(4);
    expect(open.every((o) => o.status === "completed" && o.payment.state === "unpaid")).toBe(true);
    expect(new Set(open.map((o) => o.roomBill?.room))).toEqual(new Set(["rooms-1", "rooms-2", "rooms-3"]));
    expect(open.every((o) => o.spot?.startsWith("Room "))).toBe(true);
    // None of it is received; the rest of the day is.
    const r = report(store, NOW);
    expect(r.totals.receivedMinor).toBeLessThan(r.totals.orderedMinor);
    store.close();
  });

  test("the sample's events: a rush-flagged one today for guests, a weekly one, a staff-only one in 3 days", () => {
    const store = seeded();
    const events = store.calendarEvents();
    expect(events).toHaveLength(3);
    const guest = upcoming(events, { now: NOW, timeZone: zone, audience: "guest" });
    expect(guest.map((o) => [o.title, o.inDays, o.rush])).toEqual([
      ["Lantern night market", 0, true],
      ["Folk music in the garden", 4, false],
    ]);
    expect(guest[0]?.start).toBe("17:30");
    const staff = upcoming(events, { now: NOW, timeZone: zone, audience: "staff" });
    expect(staff.find((o) => o.audience === "staff")).toMatchObject({ title: "Big produce delivery", inDays: 3 });
    expect(events.find((e) => e.repeat)?.repeat?.weekdays).toEqual([0]);
    store.close();
  });

  test("a kept demo is topped up to the clock: the next day reads like a day, and twice adds nothing", () => {
    const store = seeded(instantOn(zone, NOW, 10, 0));
    const later = NOW + DAY;
    expect(ordersOn(store, later)).toHaveLength(0);
    const placed = topUpDemo(store, { config, rush, now: later, upi: false });
    expect(placed).toBeGreaterThan(200);
    const today = ordersOn(store, later);
    const yesterday = ordersOn(store, NOW);
    expect(today.length).toBeGreaterThan(100);
    // Yesterday's afternoon was filled in too, so the comparison is fair.
    expect(yesterday.length).toBeGreaterThan(today.length);
    const pct = report(store, later).comparison.ordersChangePct;
    expect(Math.abs(pct ?? 0)).toBeLessThan(40);
    expect(store.meta(SEEDED_UNTIL)).toBe(String(later));
    expect(topUpDemo(store, { config, rush, now: later, upi: false })).toBe(0);
    expect(new Set(today.map((o) => o.token)).size).toBe(today.length);
    store.close();
  });

  test("a demo seeded before this version, without the mark, is left alone", () => {
    const store = openStore(":memory:");
    expect(topUpDemo(store, { config, rush, now: NOW, upi: false })).toBe(0);
    store.close();
  });
});
