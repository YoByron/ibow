/**
 * The report's SQL (D-044, D-045): no query scans a table that grows with history, the work does not grow as the
 * history does, and money confirmed today on an older order still counts as received today.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { addDays, localTime } from "../src/core/insights.ts";
import { advanceStatus, createOrder } from "../src/core/orders.ts";
import { confirmPayment, topUpPayment } from "../src/core/payments.ts";
import { createReportBuilder } from "../src/server/report.ts";
import type { SqlDriver, SqlValue } from "../src/store/driver.ts";
import { nodeDriver, openStore } from "../src/store/node.ts";
import { BACKFILL_SQL, createStore, REPORT_SQL, type Store } from "../src/store/store.ts";
import { loadSample } from "./support/samples.ts";

const config = loadSample("tea-house");
const tz = config.business.timeZone;
const HOUR = 3_600_000;
const DAY = 86_400_000;
// 15:30 on 26 November in Kolkata.
const now = Date.UTC(2026, 10, 26, 10, 0);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let n = 0;
function place(store: Store, at: number, qty = 1) {
  n++;
  const id = `r-${n}`;
  return store.createOrder({
    id,
    secret: "s",
    clientKey: `report-sql-key-${n}-xxxxxxxx`,
    now: at,
    timeZone: tz,
    build: (token) => createOrder(config, { id, token, now: at, lines: [{ itemId: "masala-soda", qty }] }),
  }).order;
}

describe("the report's queries", () => {
  test("no plan scans orders, order_lines, payments, payment_top_ups or payment_refunds: every one is a search", () => {
    const dir = mkdtempSync(join(tmpdir(), "ibow-plan-"));
    dirs.push(dir);
    const path = join(dir, "ibow.db");
    openStore(path).close();
    const raw = new DatabaseSync(path);
    const params: Record<keyof typeof REPORT_SQL, SqlValue[]> = {
      hourly: ["2026-11-26", 1440],
      lines: ["2026-11-26", 1440],
      received: ["2026-11-26", 1440, "2026-11-26", 1440],
      confirmed: ["2026-11-26"],
      salesLines: [0],
      salesTopUps: [0],
      salesPayments: [0],
      minutes: ["2026-11-26"],
      receivedBaseByMinute: ["2026-11-26"],
      receivedTopUpsByMinute: ["2026-11-26"],
      refundsByMinute: ["2026-11-26"],
      salesRefunds: [0],
    };
    for (const [name, sql] of Object.entries(REPORT_SQL)) {
      const plan = raw
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...(params[name as keyof typeof REPORT_SQL] as never[])) as { detail: string }[];
      const scans = plan.map((r) => r.detail).filter((d) => /^SCAN /.test(d) && !/^SCAN (ord|CONSTANT ROW)\b/.test(d));
      expect(scans, `${name}: ${plan.map((r) => r.detail).join(" | ")}`).toEqual([]);
    }
    raw.close();
  });
});

describe("start-up", () => {
  test("the check for rows without local fields is served by empty partial indexes", () => {
    const dir = mkdtempSync(join(tmpdir(), "ibow-startup-"));
    dirs.push(dir);
    const path = join(dir, "ibow.db");
    openStore(path).close();
    const raw = new DatabaseSync(path);
    for (const [name, sql] of Object.entries(BACKFILL_SQL)) {
      const plan = (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
        .map((r) => r.detail)
        .join(" | ");
      expect(plan, name).toMatch(/USING (COVERING )?INDEX (orders|payments|payment_top_ups)_unlocal/);
    }
    raw.close();
  });

  test("restarting a store with 90 days of history reads no rows to check it", () => {
    const c = counting(nodeDriver(":memory:"));
    const first = createStore(c.driver);
    first.useTimeZone(tz);
    for (let k = 90; k >= 0; k--) for (let i = 0; i < 6; i++) place(first, now - k * DAY - i * 20 * 60_000);
    const before = c.rows();
    const again = createStore(c.driver); // a restart: migrations check, then the zone is given again
    again.useTimeZone(tz);
    expect(c.rows() - before).toBe(0);
  });
});

/** A driver that counts the rows its statements return. */
function counting(driver: SqlDriver): { driver: SqlDriver; rows: () => number } {
  let rows = 0;
  return {
    rows: () => rows,
    driver: {
      ...driver,
      prepare(sql) {
        const st = driver.prepare(sql);
        return {
          get(...p) {
            const r = st.get(...p);
            if (r !== undefined) rows++;
            return r;
          },
          all(...p) {
            const r = st.all(...p);
            rows += r.length;
            return r;
          },
          run: (...p) => st.run(...p),
        };
      },
    },
  };
}

/** The reads one dashboard request makes, as the app makes them. */
function request(store: Store, at: number) {
  createReportBuilder(store, tz)(at);
}

describe("the work does not grow with the history", () => {
  function rowsFor(days: number): number {
    const c = counting(nodeDriver(":memory:"));
    const store = createStore(c.driver);
    store.useTimeZone(tz);
    for (let k = days; k >= 0; k--) {
      for (let i = 0; i < 12; i++) place(store, now - k * DAY - i * 20 * 60_000);
    }
    const today = localTime(now, tz).day;
    while (store.closeNextDay(today, tz) !== undefined);
    const before = c.rows();
    request(store, now);
    const used = c.rows() - before;
    store.close();
    return used;
  }

  test("rows a request reads: the same at 40 days of history and at 90, and no more at 15", () => {
    const fifteen = rowsFor(15);
    const forty = rowsFor(40);
    const ninety = rowsFor(90);
    console.log(`rows returned by a dashboard request: ${fifteen} at 15 days, ${forty} at 40, ${ninety} at 90`);
    expect(fifteen).toBeGreaterThan(0);
    // Past the 28 days the forecast looks back, a longer history adds nothing; a shorter one has a few empty days.
    expect(ninety).toBe(forty);
    expect(Math.abs(fifteen - ninety)).toBeLessThanOrEqual(8);
  });
});

describe("received stays exact", () => {
  test("money confirmed today on an older order counts today, a top-up counts on its own day", () => {
    const store = openStore(":memory:");
    store.useTimeZone(tz);
    const old = place(store, now - 3 * DAY, 2);
    const total = old.lines.reduce((s, l) => s + l.qty * l.unitMinor, 0);
    // Confirmed yesterday at 11:00 local, topped up today at 12:00 local, three days after the order.
    const yesterdayNoon = now - DAY - 4 * HOUR;
    let paid = confirmPayment(old.payment, { by: "counter", method: "cash", amountMinor: total, now: yesterdayNoon });
    paid = topUpPayment(paid, { by: "counter", method: "cash", amountMinor: 500, now: now - 2 * HOUR });
    store.saveOrder(advanceStatus({ ...old, payment: paid }, yesterdayNoon + 1000), "order.status", now - 2 * HOUR);
    const today = localTime(now, tz).day;
    const yesterday = addDays(today, -1);
    expect(store.dayStats(today, tz).receivedMinor).toBe(500);
    expect(store.dayStats(yesterday, tz).receivedMinor).toBe(total);
    // Up to a clock time: yesterday's money counts only once its minute has come.
    expect(store.dayStats(yesterday, tz, { untilMinute: 60 }).receivedMinor).toBe(0);
    expect(store.dayStats(yesterday, tz, { untilMinute: 24 * 60 }).receivedMinor).toBe(total);
    // The order itself belongs to its own day, three days back.
    expect(store.dayStats(today, tz).orders).toBe(0);
    expect(store.dayStats(addDays(today, -3), tz).orders).toBe(1);
    store.close();
  });

  test("rows written before the local fields existed are filled in when the time zone is given", () => {
    const dir = mkdtempSync(join(tmpdir(), "ibow-backfill-"));
    dirs.push(dir);
    const path = join(dir, "ibow.db");
    const store = openStore(path);
    place(store, now - HOUR);
    store.close();
    const raw = new DatabaseSync(path);
    raw.exec("UPDATE orders SET local_min = NULL; UPDATE payments SET day = NULL, local_min = NULL");
    raw.close();
    const check = new DatabaseSync(path);
    expect((check.prepare("SELECT local_min FROM orders").get() as { local_min: number | null }).local_min).toBeNull();
    check.close();
    const filled = openStore(path);
    filled.useTimeZone(tz);
    expect(filled.dayStats(localTime(now, tz).day, tz).orders).toBe(1);
    filled.close();
  });
});
