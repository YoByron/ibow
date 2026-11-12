import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, test } from "vitest";
import { MIN_WAIT_SAMPLE, ordersAhead, popularTags, typicalWaitMinutes } from "../src/core/storefront.ts";
import { type DemoRush, seedDemo } from "../src/demo/seed.ts";
import { openStore } from "../src/store/node.ts";
import { FIGURE_ORDERS, FIGURE_SQL, FIGURE_TOP, FIGURE_WAITS } from "../src/store/store.ts";
import { loadSample, readSample } from "./support/samples.ts";

const MIN = 60_000;
const DAY = 86_400_000;

describe("typical wait", () => {
  test("is the median of the waits in whole minutes, rounded", () => {
    expect(typicalWaitMinutes([3, 4, 5, 6, 20].map((m) => m * MIN))).toBe(5);
    expect(typicalWaitMinutes([2, 4, 6, 8, 9, 10].map((m) => m * MIN))).toBe(7);
  });

  test("is absent with too few waits, and never below one minute", () => {
    expect(typicalWaitMinutes([3, 4].map((m) => m * MIN))).toBeUndefined();
    expect(typicalWaitMinutes(Array.from({ length: MIN_WAIT_SAMPLE }, () => 12_000))).toBe(1);
  });
});

describe("popular tags", () => {
  test("the top seller is a bestseller, the next two popular, the rest nothing", () => {
    const top = [
      { itemId: "a", qty: 30 },
      { itemId: "b", qty: 20 },
      { itemId: "c", qty: 10 },
      { itemId: "d", qty: 6 },
    ];
    expect(popularTags(top)).toEqual({ a: "bestseller", b: "popular", c: "popular" });
  });

  test("items under the minimum units get no tag, and no sales no tags", () => {
    expect(popularTags([{ itemId: "a", qty: 4 }])).toEqual({});
    expect(popularTags([])).toEqual({});
  });
});

describe("the storefront figures' queries (D-050)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ibow-figures-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const path = join(dir, "ibow.db");
  const now = Date.UTC(2026, 10, 25, 13, 40);
  const store = openStore(path);
  const config = loadSample("tea-house");
  seedDemo(store, { config, rush: readSample("tea-house", "rush.json") as DemoRush, now, upi: false });

  test("answer from a bounded window: at most FIGURE_TOP sellers, FIGURE_WAITS waits", () => {
    const top = store.topSellers(now - 7 * DAY);
    expect(top.length).toBeGreaterThan(0);
    expect(top.length).toBeLessThanOrEqual(FIGURE_TOP);
    for (let i = 1; i < top.length; i++)
      expect((top[i - 1] as { qty: number }).qty).toBeGreaterThanOrEqual((top[i] as { qty: number }).qty);
    const waits = store.recentWaitsMs(now - 3 * DAY);
    expect(waits.length).toBeGreaterThan(0);
    expect(waits.length).toBeLessThanOrEqual(FIGURE_WAITS);
    expect(FIGURE_ORDERS).toBeLessThanOrEqual(500);
    // The seed holds far more orders than the window, so the bound is what limits the read.
    expect(store.salesSince(now - 7 * DAY).length).toBeGreaterThan(FIGURE_ORDERS);
  });

  test("use indexes: every table is searched, none scanned", () => {
    store.close();
    const raw = new DatabaseSync(path, { readOnly: true });
    try {
      for (const [name, sql] of Object.entries(FIGURE_SQL)) {
        const plan = raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(now - 7 * DAY) as { detail: string }[];
        const details = plan.map((p) => p.detail);
        expect(details.length, name).toBeGreaterThan(0);
        // No full scan of a real table; the named subquery is a co-routine over an index range.
        for (const d of details)
          expect(d, `${name}: ${d}`).not.toMatch(/SCAN (orders|order_lines|status_changes|l|c)\b(?! USING)/);
        expect(details.join("\n"), name).toMatch(/SEARCH (orders|order_lines|status_changes|l|c)\b/);
      }
    } finally {
      raw.close();
    }
  });
});

describe("orders ahead", () => {
  test("counts open orders placed before this one, never itself, later ones or finished ones", () => {
    const me = { id: "m", createdAt: 100 };
    const open = [
      { id: "a", createdAt: 10, status: "pending" },
      { id: "b", createdAt: 50, status: "preparing" },
      { id: "c", createdAt: 60, status: "completed" },
      { id: "m", createdAt: 100, status: "pending" },
      { id: "d", createdAt: 200, status: "pending" },
    ];
    expect(ordersAhead(me, open)).toBe(2);
    expect(ordersAhead({ id: "a", createdAt: 10 }, open)).toBe(0);
  });
});
