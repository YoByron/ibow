/**
 * SSE per audience, plus a polling fallback over the same event log. A stream never pushes the event it was woken
 * by; it pulls everything after the last id it sent, so replay after `Last-Event-ID` and live delivery are the same
 * code path and can neither skip nor repeat an event.
 */

import type { EventEmitter } from "node:events";
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Config } from "../core/config.ts";
import type { Power } from "../core/levels.ts";
import type { Order } from "../core/orders.ts";
import { type Audience, viewFor } from "../core/views.ts";
import type { EventFilter, Session, Store, StoredEvent } from "../store/store.ts";
import { ApiError, type Env } from "./errors.ts";

export interface StreamDeps {
  config: Config;
  store: Store;
  events: EventEmitter;
  now: () => number;
  ownOrder: (c: Context, id: string) => Order;
  requirePower: (c: Context<Env>, power: Power) => Session;
  heartbeatMs: number;
}

const PAGE = 500;
/** Open streams allowed at once per customer order and per staff session; a phone needs one or two. */
export const MAX_STREAMS_PER_ORDER = 3;
export const MAX_STREAMS_PER_SESSION = 5;

function filterFor(audience: Audience): EventFilter {
  if (audience.kind === "customer") return { orderId: audience.orderId };
  if (audience.kind === "station") return { stationId: audience.stationId };
  return {};
}

function matches(filter: EventFilter, e: StoredEvent): boolean {
  if (filter.orderId !== undefined) return e.orderId === filter.orderId;
  if (filter.stationId !== undefined) return e.stations.includes(filter.stationId);
  return true;
}

function payload(audience: Audience, e: StoredEvent): string {
  return JSON.stringify({ id: e.id, type: e.type, at: e.at, order: viewFor(audience, e.order) });
}

/**
 * Whether the log no longer holds what a client that last saw event `after` needs: it was pruned (D-041). The client
 * must reload its snapshot, since replay from here would silently skip events.
 */
function gapped(store: Store, after: number): boolean {
  if (after >= store.lastEventId()) return false;
  const first = store.eventsAfter(after, {}, 1)[0];
  return first === undefined || first.id > after + 1;
}

function eventId(raw: string | undefined, field: string): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new ApiError(400, "bad_event_id", `expected ${field} to be a non-negative whole number, found ${raw}`);
  }
  return n;
}

export function registerStreams(http: Hono<Env>, deps: StreamDeps): { open(): number } {
  const { config, store, events } = deps;
  /** Open streams per customer order or staff session. */
  const openStreams = new Map<string, number>();

  /** Checks access and returns the audience the path names. */
  function audienceOf(c: Context<Env>, kind: string): Audience {
    if (kind === "counter") {
      deps.requirePower(c, "orders.view");
      return { kind: "counter" };
    }
    if (kind === "owner") {
      deps.requirePower(c, "reports");
      return { kind: "owner" };
    }
    if (kind === "station") {
      deps.requirePower(c, "orders.view");
      const stationId = c.req.param("id") ?? "";
      if (!config.stations.some((s) => s.id === stationId)) {
        throw new ApiError(404, "no_such_station", `expected a station from stations.json, found ${stationId}`);
      }
      return { kind: "station", stationId };
    }
    if (kind === "order") {
      const orderId = c.req.param("id") ?? "";
      deps.ownOrder(c, orderId);
      return { kind: "customer", orderId };
    }
    throw new ApiError(404, "no_such_stream", `expected counter, owner, station or order, found ${kind}`);
  }

  function stream(c: Context<Env>, kind: string) {
    const audience = audienceOf(c, kind);
    const filter = filterFor(audience);
    const session = audience.kind === "customer" ? undefined : c.get("session");
    // A reconnecting EventSource sends Last-Event-ID; a first connect may pass the snapshot's id as ?after=.
    const resume = eventId(c.req.header("last-event-id"), "Last-Event-ID") ?? eventId(c.req.query("after"), "after");
    let last = resume ?? store.lastEventId();
    const slot = audience.kind === "customer" ? `order:${audience.orderId}` : `session:${session?.idHash}`;
    const cap = audience.kind === "customer" ? MAX_STREAMS_PER_ORDER : MAX_STREAMS_PER_SESSION;
    const used = openStreams.get(slot) ?? 0;
    if (used >= cap) {
      throw new ApiError(429, "too_many_streams", `expected at most ${cap} open streams here, found ${used}`);
    }
    openStreams.set(slot, used + 1);
    const release = () => {
      const n = (openStreams.get(slot) ?? 1) - 1;
      if (n <= 0) openStreams.delete(slot);
      else openStreams.set(slot, n);
    };

    return streamSSE(c, async (sse) => {
      let pulling = false;
      let again = false;
      const pull = async (): Promise<void> => {
        if (pulling) {
          again = true;
          return;
        }
        pulling = true;
        try {
          do {
            again = false;
            let page: StoredEvent[];
            do {
              page = store.eventsAfter(last, filter, PAGE);
              for (const e of page) {
                if (sse.aborted) return;
                await sse.writeSSE({ id: String(e.id), data: payload(audience, e) });
                last = e.id;
              }
            } while (page.length === PAGE);
          } while (again && !sse.aborted);
        } finally {
          pulling = false;
        }
      };
      const onEvent = (e: StoredEvent) => {
        if (matches(filter, e)) pull().catch(() => sse.abort());
      };
      const done = new Promise<void>((resolve) => sse.onAbort(resolve));
      // Each beat re-checks the session, so a logout, a PIN change or expiry ends a staff stream within one beat.
      const heartbeat = setInterval(() => {
        if (session !== undefined && store.getSession(session.idHash, deps.now()) === undefined) {
          sse.abort();
          return;
        }
        sse.write(": keep-alive\n\n").catch(() => sse.abort());
      }, deps.heartbeatMs);
      events.on("event", onEvent);
      try {
        await sse.write("retry: 2000\n\n");
        if (resume !== undefined && gapped(store, resume)) {
          last = store.lastEventId();
          await sse.writeSSE({ event: "reset", data: String(last) });
        }
        await pull();
        await done;
      } finally {
        clearInterval(heartbeat);
        events.off("event", onEvent);
        release();
      }
    });
  }

  function poll(c: Context<Env>, kind: string) {
    const audience = audienceOf(c, kind);
    const after = eventId(c.req.query("after"), "after") ?? 0;
    if (gapped(store, after)) return c.json({ events: [], lastEventId: store.lastEventId(), reset: true });
    const page = store.eventsAfter(after, filterFor(audience), PAGE);
    // Synchronous with the read above, so no matching event can fall between the page and this id.
    const lastEventId = page.length === PAGE ? (page.at(-1) as StoredEvent).id : Math.max(after, store.lastEventId());
    return c.json({ events: page.map((e) => JSON.parse(payload(audience, e))), lastEventId });
  }

  http.get("/api/stream/:kind", (c) => stream(c, c.req.param("kind")));
  http.get("/api/stream/:kind/:id", (c) => stream(c, c.req.param("kind")));
  http.get("/api/poll/:kind", (c) => poll(c, c.req.param("kind")));
  http.get("/api/poll/:kind/:id", (c) => poll(c, c.req.param("kind")));
  return { open: () => [...openStreams.values()].reduce((a, b) => a + b, 0) };
}
