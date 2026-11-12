/**
 * M2 checkpoint: boot the real server on a temporary database, replay a sample's rush concurrently through the API,
 * and check every station stream, token uniqueness and a forced reconnect with Last-Event-ID.
 */

import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { describe, expect, test } from "vitest";
import { createApp } from "../src/server/app.ts";
import { hashPin } from "../src/server/auth.ts";
import { openStore } from "../src/store/node.ts";
import { TEST_PIN_COST } from "./support/auth.ts";
import type { Rush } from "./support/rush.ts";
import { loadSample, readSample } from "./support/samples.ts";
import { openSse, parsed, type SseStream } from "./support/sse.ts";

/**
 * Runs `fn` over `items` with `limit` requests in flight. Windows refuses connections once a few hundred arrive in the
 * same instant (its accept queue, whatever the listen backlog), so the replay keeps 50 open at a time, still concurrent.
 */
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

interface Line {
  stationId: string;
  index?: number;
}
interface EventBody {
  id: number;
  type: string;
  order: { id: string; token: string; lines: Line[] };
}

describe.each([
  ["tea-house", "tea"],
  ["service-desk", "workshop"],
])("checkpoint: %s rush through the server", (sample, reconnectStation) => {
  test("unique tokens, each station gets exactly its own lines, and a reconnect misses nothing", {
    timeout: 120_000,
  }, async () => {
    const config = loadSample(sample);
    const rush = readSample(sample, "rush.json") as Rush;
    const dir = mkdtempSync(join(tmpdir(), "ibow-checkpoint-"));
    const store = openStore(join(dir, "ibow.db"));
    const app = createApp({
      config,
      store,
      ownerPinHash: await hashPin("908172", TEST_PIN_COST),
      now: () => rush.start,
      limits: { orderCreate: { max: 100_000, windowMs: 60_000 } },
    });
    const server = await new Promise<Server>((resolve) => {
      const s = serve({ fetch: app.http.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s as Server));
    });
    // Keep idle sockets open longer than the fetch client does (undici's default is 4 s), so the server never closes
    // a socket in the instant the client reuses it, which showed up as ECONNRESET under load on Windows.
    server.keepAliveTimeout = 65_000;
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const streams: SseStream[] = [];

    async function api(method: string, path: string, body?: unknown, cookie?: string, retried = false) {
      let res: Response;
      try {
        res = await fetch(base + path, {
          method,
          headers: {
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...(cookie ? { cookie } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (e) {
        // A reset socket is retried once, but only for order creates, which the clientKey makes idempotent.
        const code = ((e as Error).cause as { code?: string } | undefined)?.code;
        if (retried || code !== "ECONNRESET" || path !== "/api/orders") throw e;
        return api(method, path, body, cookie, true);
      }
      return { status: res.status, cookie: res.headers.get("set-cookie")?.split(";")[0], body: await res.json() };
    }
    async function listen(path: string, cookie: string, lastEventId?: string): Promise<SseStream> {
      const headers: Record<string, string> = { cookie };
      if (lastEventId !== undefined) headers["last-event-id"] = lastEventId;
      const s = await openSse(fetch(base + path, { headers }));
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

      // Every order, 50 in flight at a time, then every order moved to preparing the same way.
      const rushDone = (async () => {
        const created = await inParallel(rush.orders, 50, (o, i) =>
          api("POST", "/api/orders", { clientKey: `${sample}-rush-order-${i}`, lines: o.lines }),
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

      // The reference: every event, as the counter saw it, with whole orders.
      const total = rush.orders.length * 2;
      await counter.until((m) => m.length === total, 30_000);
      const all = parsed(counter.messages) as EventBody[];
      expect(all.map((e) => e.id)).toEqual(Array.from({ length: total }, (_, i) => i + 1));

      for (const station of config.stations) {
        const expected = all.filter((e) => e.order.lines.some((l) => l.stationId === station.id));
        const messages =
          station.id === reconnectStation
            ? await resumed
                .until((m) => before.length + m.length >= expected.length, 30_000)
                .then((m) => [...before, ...m])
            : await (stationStreams.get(station.id) as SseStream).until((m) => m.length >= expected.length, 30_000);
        const got = parsed(messages) as EventBody[];
        // No gaps, no duplicates, nothing for another station.
        expect(
          got.map((e) => e.id),
          station.id,
        ).toEqual(expected.map((e) => e.id));
        for (const e of got) {
          for (const l of e.order.lines) expect(l.stationId, `${station.id} event ${e.id}`).toBe(station.id);
        }
        // Exactly its own lines: per order, the indexes the station saw are those routed to it.
        const createdEvents = got.filter((e) => e.type === "order.created");
        const seen = createdEvents.map((e) => `${e.order.id}:${e.order.lines.map((l) => l.index).join(",")}`);
        const own = all
          .filter((e) => e.type === "order.created")
          .flatMap((e) => {
            const idx = e.order.lines.flatMap((l, i) => (l.stationId === station.id ? [i] : []));
            return idx.length ? [`${e.order.id}:${idx.join(",")}`] : [];
          });
        expect(seen, station.id).toEqual(own);
      }
      expect(before.length).toBeGreaterThan(0);
      expect(resumed.messages.length, "events missed while disconnected").toBeGreaterThan(0);
    } finally {
      for (const s of streams) await s.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
