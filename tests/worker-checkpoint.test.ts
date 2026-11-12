/**
 * M9 checkpoint: the 300-order tea-house rush replayed against the Worker and its Durable Object in workerd, 50 in
 * flight, then every order moved to preparing; unique tokens, every station stream complete after a forced reconnect,
 * and the rows the rush wrote counted against the free plan's daily limit (D-036).
 */

import { describe, expect, test, vi } from "vitest";
import { hashPin } from "../src/server/auth.ts";
import { TEST_PIN_COST } from "./support/auth.ts";
import type { Rush } from "./support/rush.ts";
import { loadSample, readSample } from "./support/samples.ts";
import { openSse, parsed, type SseStream } from "./support/sse.ts";
import { startWorker } from "./support/worker.ts";

vi.setConfig({ testTimeout: 240_000 });

/** Runs `fn` over `items` with `limit` in flight, as the node checkpoint does. */
async function inParallel<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

interface EventBody {
  id: number;
  type: string;
  order: { id: string; token: string; lines: { stationId: string; index?: number }[] };
}

/** Cloudflare's free plan: rows written per day across a Durable Object's tables and indexes. */
const FREE_ROWS_WRITTEN_PER_DAY = 100_000;
const FREE_REQUESTS_PER_DAY = 100_000;
const FREE_ROWS_READ_PER_DAY = 5_000_000;

describe("checkpoint: the tea-house rush through the Worker and its Durable Object", () => {
  test("unique tokens, each station gets exactly its own lines, a reconnect misses nothing", async () => {
    const sample = "tea-house";
    const config = loadSample(sample);
    const rush = readSample(sample, "rush.json") as Rush;
    const w = await startWorker({ env: { OWNER_PIN_HASH: await hashPin("908172", TEST_PIN_COST) } });
    const streams: SseStream[] = [];
    let requests = 0;

    async function api(method: string, path: string, body?: unknown, cookie?: string, ip?: string) {
      requests++;
      const res = await fetch(w.base + path, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(cookie ? { cookie } : {}),
          // Customers arrive from many addresses; Cloudflare sets this header, here the test does.
          ...(ip ? { "cf-connecting-ip": ip } : {}),
          // A fresh connection each time: workerd closes idle ones, and a reused one fails the next request on a race.
          connection: "close",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, cookie: res.headers.get("set-cookie")?.split(";")[0], body: await res.json() };
    }
    async function listen(path: string, cookie: string, lastEventId?: string): Promise<SseStream> {
      requests++;
      const headers: Record<string, string> = { cookie };
      if (lastEventId !== undefined) headers["last-event-id"] = lastEventId;
      const s = await openSse(fetch(w.base + path, { headers }));
      expect(s.status, path).toBe(200);
      streams.push(s);
      return s;
    }

    try {
      const owner = (await api("POST", "/api/login", { user: "owner", pin: "908172" })).cookie as string;
      expect((await api("PUT", "/api/staff/counter-1", { name: "Counter", pin: "1357" }, owner)).status).toBe(200);
      const staff = (await api("POST", "/api/login", { user: "counter-1", pin: "1357" })).cookie as string;

      const counter = await listen("/api/stream/counter", staff);
      const stationStreams = new Map<string, SseStream>();
      for (const s of config.stations) stationStreams.set(s.id, await listen(`/api/stream/station/${s.id}`, staff));
      const reconnectStation = "tea";
      expect(stationStreams.has(reconnectStation)).toBe(true);

      const rushDone = (async () => {
        const created = await inParallel(rush.orders, 50, (o, i) =>
          api(
            "POST",
            "/api/orders",
            { clientKey: `worker-rush-order-${i}`, lines: o.lines },
            undefined,
            `10.1.${i >> 8}.${i & 255}`,
          ),
        );
        await inParallel(created, 50, (c) => api("POST", `/api/orders/${c.body.order.id}/advance`, undefined, staff));
        return created;
      })();

      // Force a disconnect mid-rush, then reconnect once the rush is over, from the last id received.
      const dropped = stationStreams.get(reconnectStation) as SseStream;
      await dropped.until((m) => m.length >= 10);
      await dropped.close();
      const created = await rushDone;
      const before = dropped.messages.slice();
      const resumed = await listen(`/api/stream/station/${reconnectStation}`, staff, before.at(-1)?.id as string);

      expect(created.map((c) => c.status)).toEqual(rush.orders.map(() => 201));
      const tokens = created.map((c) => c.body.order.token as string);
      expect(new Set(tokens).size).toBe(rush.orders.length);

      const total = rush.orders.length * 2;
      await counter.until((m) => m.length === total, 60_000);
      const all = parsed(counter.messages) as EventBody[];
      expect(all.map((e) => e.id)).toEqual(Array.from({ length: total }, (_, i) => i + 1));

      for (const station of config.stations) {
        const expected = all.filter((e) => e.order.lines.some((l) => l.stationId === station.id));
        const messages =
          station.id === reconnectStation
            ? await resumed
                .until((m) => before.length + m.length >= expected.length, 60_000)
                .then((m) => [...before, ...m])
            : await (stationStreams.get(station.id) as SseStream).until((m) => m.length >= expected.length, 60_000);
        const got = parsed(messages) as EventBody[];
        expect(
          got.map((e) => e.id),
          station.id,
        ).toEqual(expected.map((e) => e.id));
        for (const e of got) {
          for (const l of e.order.lines) expect(l.stationId, `${station.id} event ${e.id}`).toBe(station.id);
        }
      }
      expect(before.length).toBeGreaterThan(0);
      expect(resumed.messages.length, "events missed while disconnected").toBeGreaterThan(0);

      const stats = (await (await w.internal("/__stats")).json()) as { rowsWritten: number; rowsRead: number };
      console.log(
        `worker rush: ${rush.orders.length} orders, ${requests} requests, ${stats.rowsWritten} rows written, ` +
          `${stats.rowsRead} rows read (free plan per day: ${FREE_ROWS_WRITTEN_PER_DAY} written, 5 000 000 read, ${FREE_REQUESTS_PER_DAY} requests)`,
      );
      // The owner's dashboard: the first report reads today's and yesterday's orders, and while no event arrives every
      // further request, from any tab or device, is served from memory with no history read at all (D-044). An open
      // tab polls every 5 minutes (12 an hour); a report is recomputed only after an event, or when the day turns.
      const readsNow = async () => ((await (await w.internal("/__stats")).json()) as { rowsRead: number }).rowsRead;
      const r0 = await readsNow();
      expect((await api("GET", "/api/owner/insights", undefined, owner)).status).toBe(200);
      const r1 = await readsNow();
      await api("GET", "/api/owner/insights", undefined, owner);
      const r2 = await readsNow();
      const reportReads = r1 - r0;
      const dashboardPerHour = 12 * reportReads; // worst case: an event arrived between every refresh
      console.log(
        `dashboard: one report reads ${reportReads} rows, a repeat ${r2 - r1}; an open tab at worst ${dashboardPerHour} an hour`,
      );
      expect(reportReads).toBeGreaterThan(0);
      expect(r2 - r1).toBeLessThan(10); // the session lookup only, not the history
      for (let poll = 0; poll < 12; poll++) await api("GET", "/api/owner/insights", undefined, owner);
      const idleHour = (await readsNow()) - r2;
      console.log(`an idle open tab for an hour: ${idleHour} rows read`);
      expect(idleHour).toBeLessThan(12 * 10);
      // Eight hours of an open tab, on top of the rush's own reads, stays inside the day's 5 million.
      expect(stats.rowsRead + 8 * dashboardPerHour).toBeLessThan(FREE_ROWS_READ_PER_DAY);
      const ownDb = ((await (await w.internal("/__stats")).json()) as { databaseSize: number }).databaseSize;
      console.log(
        `storage: ${ownDb} bytes for ${rush.orders.length} orders, ${Math.round(ownDb / rush.orders.length)} a order`,
      );
      expect(stats.rowsWritten).toBeLessThan(FREE_ROWS_WRITTEN_PER_DAY);
      expect(requests).toBeLessThan(FREE_REQUESTS_PER_DAY);
    } finally {
      for (const s of streams) await s.close();
      await w.stop();
    }
  });
});
