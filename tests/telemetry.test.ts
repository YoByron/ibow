/** The install's health (D-076): counted in memory, one row per hour, never one per request, nothing sent anywhere. */

import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { FREE_ROWS_WRITTEN_PER_DAY, HOUR_MS, type HourCount, healthFrom, hourOf } from "../src/core/health.ts";
import type { Env } from "../src/server/errors.ts";
import { createTelemetry, FLUSH_MS } from "../src/server/telemetry.ts";
import { nodeDriver } from "../src/store/node.ts";
import { createStore } from "../src/store/store.ts";

const t0 = Date.UTC(2026, 11, 1, 10, 0, 0);

const hourRow = (h: number, over: Partial<HourCount> = {}): HourCount => ({
  hour: h,
  requests: 0,
  errors: 0,
  rowsWritten: 0,
  routes: {},
  ...over,
});

describe("healthFrom", () => {
  test("24 hours, oldest first, empty hours included; the pending counts join the stored ones", () => {
    const now = t0 + 30 * 60_000;
    const h = hourOf(now);
    const health = healthFrom(
      [hourRow(h - 2, { requests: 10, errors: 1, routes: { "GET /api/a": { n: 10, totalMs: 100, maxMs: 40 } } })],
      hourRow(h, { requests: 5, routes: { "GET /api/a": { n: 5, totalMs: 500, maxMs: 300 } } }),
      now,
    );
    expect(health.hours).toHaveLength(24);
    expect(health.hours.at(-1)).toEqual({ at: h * HOUR_MS, requests: 5, errors: 0 });
    expect(health.hours.at(-3)).toEqual({ at: (h - 2) * HOUR_MS, requests: 10, errors: 1 });
    expect(health.hours[0]?.requests).toBe(0);
    expect(health.requests).toBe(15);
    expect(health.errors).toBe(1);
    expect(health.slowest).toEqual([{ route: "GET /api/a", n: 15, avgMs: 40, maxMs: 300 }]);
  });

  test("rows written today count from 00:00 UTC, when the free plan's day starts, and not before", () => {
    const now = Date.UTC(2026, 11, 1, 3, 0);
    const midnight = Date.UTC(2026, 11, 1, 0, 0);
    const health = healthFrom(
      [
        hourRow(hourOf(midnight) - 1, { rowsWritten: 9000 }),
        hourRow(hourOf(midnight), { rowsWritten: 120 }),
        hourRow(hourOf(midnight) + 2, { rowsWritten: 30 }),
      ],
      undefined,
      now,
    );
    expect(health.rows).toEqual({ writtenToday: 150, limit: FREE_ROWS_WRITTEN_PER_DAY, dayStart: midnight });
  });

  test("the slowest routes are the worst single times, five at most", () => {
    const routes = Object.fromEntries(
      ["a", "b", "c", "d", "e", "f", "g"].map((k, i) => [k, { n: 1, totalMs: i, maxMs: i }]),
    );
    const health = healthFrom([hourRow(hourOf(t0), { routes })], undefined, t0);
    expect(health.slowest.map((s) => s.route)).toEqual(["g", "f", "e", "d", "c"]);
  });
});

function setup() {
  let now = t0;
  const driver = nodeDriver(":memory:");
  const counts = { telemetryWrites: 0 };
  const watched = {
    ...driver,
    prepare(sql: string) {
      const st = driver.prepare(sql);
      return {
        ...st,
        run: (...p: Parameters<typeof st.run>) => {
          if (sql.includes("INTO telemetry_hours")) counts.telemetryWrites++;
          return st.run(...p);
        },
      };
    },
  };
  const store = createStore(watched);
  const telemetry = createTelemetry({
    store,
    now: () => now,
    build: "test-build",
    startedAt: t0 - 5 * 60_000,
    openStreams: () => 3,
    lastBackup: () => t0 - HOUR_MS,
  });
  const http = new Hono<Env>();
  http.use("*", telemetry.middleware);
  http.get("/api/ok/:id", (c) => c.json({ ok: true }));
  http.get("/api/boom", () => {
    throw new Error("boom");
  });
  http.get("/api/admin/health", (c) => c.json(telemetry.snapshot()));
  return { http, telemetry, store, counts, advance: (ms: number) => (now += ms) };
}

describe("the counters", () => {
  test("requests, errors and routes are counted by the route's pattern, and the admin's own reads are not counted", async () => {
    const { http, telemetry } = setup();
    for (let i = 0; i < 4; i++) await http.request(`/api/ok/${i}`);
    expect((await http.request("/api/boom")).status).toBe(500);
    await http.request("/api/admin/health");
    const s = telemetry.snapshot();
    expect(s.requests).toBe(5);
    expect(s.errors).toBe(1);
    expect(s.slowest.map((r) => r.route).sort()).toEqual(["GET /api/boom", "GET /api/ok/:id"]);
    expect(s.openStreams).toBe(3);
    expect(s.build).toBe("test-build");
    expect(s.uptimeMs).toBe(5 * 60_000);
    expect(s.lastBackup).toEqual({ at: t0 - HOUR_MS, source: "backup" });
    expect(s.databaseBytes).toBeGreaterThan(0);
  });

  test("a restart still shows the hours already written", async () => {
    const { http, telemetry, store } = setup();
    for (let i = 0; i < 6; i++) await http.request(`/api/ok/${i}`);
    telemetry.flush(true);
    const again = createTelemetry({ store, now: () => t0, build: "b", startedAt: t0, openStreams: () => 0 });
    expect(again.snapshot().requests).toBe(6);
  });
});

describe("cost against a 300-order day", () => {
  test("3 600 requests over 12 busy hours write the hour's row about every half minute, never one per request", async () => {
    const { http, counts, advance, telemetry, store } = setup();
    // A 300-order day: about 12 requests per order (create, polls, staff actions), spread over 12 hours.
    for (let i = 0; i < 3600; i++) {
      advance((12 * HOUR_MS) / 3600);
      await http.request(`/api/ok/${i}`);
    }
    const busyHours = 12;
    const ceiling = (busyHours * HOUR_MS) / FLUSH_MS;
    console.log(`telemetry writes for 3600 requests over 12 h: ${counts.telemetryWrites} (at most ${ceiling})`);
    expect(counts.telemetryWrites).toBeGreaterThan(0);
    expect(counts.telemetryWrites).toBeLessThanOrEqual(ceiling + busyHours);
    expect(counts.telemetryWrites).toBeLessThan(3600 / 2);
    telemetry.flush(true);
    const kept = store.telemetryHours(0);
    expect(kept.reduce((n, h) => n + h.requests, 0)).toBe(3600);
    // A row per hour, not per flush.
    expect(kept.length).toBeLessThanOrEqual(13);
  });

  test("a quiet install writes nothing", () => {
    const { counts, advance, telemetry } = setup();
    advance(10 * HOUR_MS);
    telemetry.flush(true);
    expect(counts.telemetryWrites).toBe(0);
  });
});

import { verdict } from "../src/core/health.ts";

describe("the verdict", () => {
  const base = healthFrom([], undefined, t0);
  test("healthy when errors are rare, rows and size are well inside the free plan", () => {
    expect(verdict({ ...base, requests: 1000, errors: 5 }, 10_000_000)).toEqual({ ok: true, concerns: [] });
  });
  test("each concern is named: errors once there are 50 requests to judge by, rows, size", () => {
    expect(verdict({ ...base, requests: 49, errors: 49 }, 0).ok).toBe(true);
    expect(verdict({ ...base, requests: 100, errors: 3 }, 0).concerns).toEqual(["errors"]);
    expect(verdict({ ...base, rows: { ...base.rows, writtenToday: 80_001 } }, 0).concerns).toEqual(["rows"]);
    expect(verdict(base, 800_000_001).concerns).toEqual(["size"]);
  });
});
