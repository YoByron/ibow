import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_RETENTION_DAYS, parseBusiness } from "../src/core/config.ts";
import { advanceStatus, createOrder } from "../src/core/orders.ts";
import { startRetention } from "../src/server/retention.ts";
import { openStore } from "../src/store/node.ts";
import type { Store } from "../src/store/store.ts";
import { loadSample } from "./support/samples.ts";

const config = loadSample("tea-house");
const DAY = 86_400_000;
const t0 = Date.UTC(2026, 10, 1, 12, 0);
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  vi.useRealTimers();
});

let n = 0;
function place(store: Store, at: number, customerName?: string) {
  n++;
  const id = `o-${n}`;
  const { order } = store.createOrder({
    id,
    secret: `s-${n}`,
    clientKey: `client-key-${n}-xxxxxxxx`,
    now: at,
    timeZone: config.business.timeZone,
    build: (token) =>
      createOrder(config, {
        id,
        token,
        now: at,
        lines: [{ itemId: "masala-soda", qty: 2 }],
        ...(customerName ? { customerName } : {}),
      }),
  });
  // Another event for the order, so every snapshot of it has to lose the name.
  const done = advanceStatus(advanceStatus(order, at + 60_000), at + 120_000);
  store.saveOrder(done, "order.status", at + 120_000);
  store.putReview({ orderId: id, rating: 5, text: `Lovely, says ${customerName ?? "someone"}`, at: at + 180_000 });
  return id;
}

function fresh(): Store {
  const s = openStore(":memory:");
  stores.push(s);
  return s;
}

describe("retention", () => {
  test("business.json may set retentionDays, a whole number from 1 to 3650, default 30", () => {
    const business = { name: "B", currency: "INR", timeZone: "Asia/Kolkata" };
    expect(DEFAULT_RETENTION_DAYS).toBe(30);
    expect(parseBusiness(business).retentionDays).toBe(30);
    expect(parseBusiness({ ...business, retentionDays: 7 }).retentionDays).toBe(7);
    for (const bad of [0, 1.5, 3651, "30"]) {
      expect(() => parseBusiness({ ...business, retentionDays: bad })).toThrow(/retentionDays/);
    }
  });

  test("the store clears names and review text older than the cutoff, in orders, events and reviews", () => {
    const store = fresh();
    const old = place(store, t0, "Asha");
    const recent = place(store, t0 + 20 * DAY, "Ravi");
    const cleared = store.forgetCustomers(t0 + 10 * DAY);
    expect(cleared).toEqual({ orders: 1, events: 2, reviews: 1 });

    expect(store.getOrder(old)?.order.customerName).toBeUndefined();
    expect(store.getReview(old)).toEqual({ orderId: old, rating: 5, at: t0 + 180_000 });
    const oldEvents = store.eventsAfter(0, { orderId: old });
    expect(oldEvents).toHaveLength(2);
    for (const e of oldEvents) expect(e.order.customerName).toBeUndefined();
    // Anonymous counts stay: the order, its lines and its rating.
    expect(store.getOrder(old)?.order.lines[0]?.qty).toBe(2);

    expect(store.getOrder(recent)?.order.customerName).toBe("Ravi");
    expect(store.getReview(recent)?.text).toBe("Lovely, says Ravi");
    for (const e of store.eventsAfter(0, { orderId: recent })) expect(e.order.customerName).toBe("Ravi");
    // A second pass finds nothing left to clear.
    expect(store.forgetCustomers(t0 + 10 * DAY)).toEqual({ orders: 0, events: 0, reviews: 0 });
  });

  test("each pass reads only what came of age since the last one, from a mark kept in the store", () => {
    const dir = mkdtempSync(join(tmpdir(), "ibow-mark-"));
    const path = join(dir, "ibow.db");
    let store = openStore(path);
    try {
      expect(store.retentionMark()).toBe(0);
      place(store, t0, "Asha");
      expect(store.forgetCustomers(t0 + DAY)).toMatchObject({ orders: 1, reviews: 1 });
      expect(store.retentionMark()).toBe(t0 + DAY);
      // An earlier cutoff (retentionDays raised) has nothing left to do and keeps the mark.
      expect(store.forgetCustomers(t0)).toEqual({ orders: 0, events: 0, reviews: 0 });
      expect(store.retentionMark()).toBe(t0 + DAY);
      store.close();
      store = openStore(path);
      expect(store.retentionMark()).toBe(t0 + DAY);
      // Proof the scan is bounded: a row behind the mark (which a real clock never writes) is not read again,
      const behind = place(store, t0 + 60_000, "Behind");
      // while one that came of age inside the new window is cleared.
      const inside = place(store, t0 + 2 * DAY, "Ravi");
      expect(store.forgetCustomers(t0 + 3 * DAY)).toMatchObject({ orders: 1, reviews: 1 });
      expect(store.getOrder(inside)?.order.customerName).toBeUndefined();
      expect(store.getOrder(behind)?.order.customerName).toBe("Behind");
      expect(store.retentionMark()).toBe(t0 + 3 * DAY);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a cleared name or review text is gone from the database files themselves, not only from queries", () => {
    const dir = mkdtempSync(join(tmpdir(), "ibow-retention-"));
    try {
      const path = join(dir, "ibow.db");
      const store = openStore(path);
      // Distinctive markers, so a stray copy anywhere in the bytes is found.
      for (let i = 0; i < 40; i++) place(store, t0 + i * 60_000, `Zanzibarqueen${i % 4}`);
      place(store, t0 + 20 * DAY, "Keptname");
      store.forgetCustomers(t0 + 10 * DAY);
      store.close();
      const bytes = ["", "-wal", "-shm"]
        .map((suffix) => path + suffix)
        .filter((f) => existsSync(f))
        .map((f) => readFileSync(f).toString("latin1"))
        .join("");
      expect(bytes).toContain("Keptname");
      expect(bytes).not.toContain("Zanzibarqueen");
      expect(bytes).not.toContain("Lovely, says Zanzibar");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a name is overwritten with spaces of the same length before it is nulled (for engines that cannot secure_delete)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ibow-overwrite-"));
    try {
      const path = join(dir, "ibow.db");
      const store = openStore(path);
      place(store, t0, "Zanzibarqueen");
      store.close();
      // Record every value the column takes: a trigger on a second connection sees each UPDATE's new value in turn.
      const raw = new DatabaseSync(path);
      raw.exec(`CREATE TABLE seen (what TEXT, value TEXT);
        CREATE TRIGGER seen_o AFTER UPDATE OF customer_name ON orders BEGIN INSERT INTO seen VALUES ('order', new.customer_name); END;
        CREATE TRIGGER seen_e AFTER UPDATE OF data ON events BEGIN
          INSERT INTO seen VALUES ('event', json_extract(new.data, '$.customerName')); END;`);
      raw.close();
      const again = openStore(path);
      again.forgetCustomers(t0 + 10 * DAY);
      again.close();
      const check = new DatabaseSync(path);
      const order = (
        check.prepare("SELECT value FROM seen WHERE what = 'order'").all() as { value: string | null }[]
      ).map((r) => r.value);
      expect(order).toEqual([" ".repeat("Zanzibarqueen".length), null]);
      const event = (
        check.prepare("SELECT value FROM seen WHERE what = 'event'").all() as { value: string | null }[]
      ).map((r) => r.value);
      expect(event[0]).toBe(" ".repeat("Zanzibarqueen".length));
      expect(event.at(-1)).toBeNull();
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("events are blanked with same-length spaces before pruning deletes them", () => {
    const dir = mkdtempSync(join(tmpdir(), "ibow-prune-"));
    try {
      const path = join(dir, "ibow.db");
      const store = openStore(path);
      place(store, t0, "Zanzibarqueen");
      store.close();
      const raw = new DatabaseSync(path);
      raw.exec(`CREATE TABLE seen (value TEXT);
        CREATE TRIGGER seen_d BEFORE DELETE ON events BEGIN
          INSERT INTO seen VALUES (json_extract(old.data, '$.customerName')); END;`);
      raw.close();
      const again = openStore(path);
      const pruned = again.pruneEvents(t0 + DAY);
      again.close();
      expect(pruned).toBeGreaterThan(0);
      const check = new DatabaseSync(path);
      const seen = (check.prepare("SELECT value FROM seen").all() as { value: string }[]).map((x) => x.value);
      expect(seen).toEqual(Array(pruned).fill(" ".repeat("Zanzibarqueen".length)));
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an install from before this release is vacuumed once on upgrade, so free pages from old deletes are gone", () => {
    const dir = mkdtempSync(join(tmpdir(), "ibow-vacuum-"));
    try {
      const path = join(dir, "ibow.db");
      openStore(path).close();
      // Simulate the old schema with a name deleted the old way: freed, not zeroed.
      const raw = new DatabaseSync(path);
      raw.exec("PRAGMA secure_delete = OFF");
      raw.exec("CREATE TABLE scratch (t TEXT)");
      raw.exec(`INSERT INTO scratch VALUES ('${"Oldfreepagename".repeat(50)}')`);
      raw.exec("DROP TABLE scratch");
      // Back to schema 7, the last before the VACUUM step: undo the migrations after it (the retention mark, the day totals, the local fields, the theme override).
      raw.exec(
        "DROP TABLE theme_override; DROP TABLE day_totals; DROP TABLE retention; DROP INDEX reviews_at; DROP INDEX payments_day; DROP INDEX payment_top_ups_day; DROP INDEX orders_unlocal; DROP INDEX payments_unlocal; DROP INDEX payment_top_ups_unlocal;" +
          "ALTER TABLE orders DROP COLUMN local_min; ALTER TABLE payments DROP COLUMN day; ALTER TABLE payments DROP COLUMN local_min;" +
          "ALTER TABLE payment_top_ups DROP COLUMN day; ALTER TABLE payment_top_ups DROP COLUMN local_min; PRAGMA user_version = 7",
      );
      raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      raw.close();
      expect(readFileSync(path).toString("latin1")).toContain("Oldfreepagename");
      openStore(path).close();
      expect(readFileSync(path).toString("latin1")).not.toContain("Oldfreepagename");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("runs at startup and then periodically, with the clock it is given", () => {
    vi.useFakeTimers();
    const store = fresh();
    let now = t0;
    const a = place(store, t0, "Asha");
    const b = place(store, t0 + 2 * DAY, "Ravi");
    // 30 days and a minute after the first order: it goes at startup, the second stays.
    now = t0 + 30 * DAY + 60_000;
    const runs: number[] = [];
    const stop = startRetention({
      store,
      days: 30,
      now: () => now,
      everyMs: 60 * 60_000,
      onRun: (r) => runs.push(r.orders),
    });
    expect(store.getOrder(a)?.order.customerName).toBeUndefined();
    expect(store.getOrder(b)?.order.customerName).toBe("Ravi");
    // Two days later the hourly run clears the second.
    now += 2 * DAY;
    vi.advanceTimersByTime(60 * 60_000);
    expect(store.getOrder(b)?.order.customerName).toBeUndefined();
    expect(runs).toEqual([1, 1]);
    stop();
    vi.advanceTimersByTime(10 * 60 * 60_000);
    expect(runs).toHaveLength(2);
  });
});
