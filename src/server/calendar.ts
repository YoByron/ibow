/**
 * The business's events over HTTP (D-084). `GET /api/events` is public and answers the coming week's guest events; with any
 * signed-in session it adds the staff-only ones. Owners and managers (`events.manage`) list, add, change and delete events.
 * The events are held in memory (this process is the only writer, D-031), so the banner every page asks for costs no read;
 * events are deleted `KEEP_DAYS` after their last day, checked once per business day.
 */

import type { Context, Hono } from "hono";
import {
  type CalendarEvent,
  EventError,
  type EventInput,
  expired,
  MAX_EVENTS,
  parseEvent,
  upcoming,
} from "../core/calendar.ts";
import { localTime } from "../core/insights.ts";
import type { Power } from "../core/levels.ts";
import type { Session, Store } from "../store/store.ts";
import { ApiError, type Env } from "./errors.ts";

/** Marks the install as having read `events.json` once, so a deleted seed event never comes back at the next start. */
const SEEDED = "events_seeded";

export interface CalendarDeps {
  store: Store;
  timeZone: string;
  /** The business currency, so a banner can show an event's price. */
  currency: string;
  now: () => number;
  requirePower: (c: Context<Env>, power: Power) => Session;
  /** `events.json` of the config folder, already checked: stored once, on the first start that sees it. */
  seed?: readonly EventInput[];
}

export function registerCalendar(http: Hono<Env>, deps: CalendarDeps): void {
  const { store, timeZone, currency, now, requirePower } = deps;
  if (store.meta(SEEDED) === undefined) {
    for (const e of (deps.seed ?? []).slice(0, MAX_EVENTS)) store.addCalendarEvent(e, "events.json", now());
    store.setMeta(SEEDED, String(now()));
  }
  let events: CalendarEvent[] = store.calendarEvents();
  let prunedOn = "";

  /** Deletes what has run its course, at most once a business day; then the list in memory. */
  function current(): CalendarEvent[] {
    const today = localTime(now(), timeZone).day;
    if (today !== prunedOn) {
      prunedOn = today;
      const gone = events.filter((e) => expired(e, today)).map((e) => e.id);
      if (gone.length > 0) {
        store.deleteCalendarEvents(gone);
        events = events.filter((e) => !gone.includes(e.id));
      }
    }
    return events;
  }

  async function eventBody(c: Context<Env>): Promise<EventInput> {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError(400, "bad_json", "expected a JSON body, found something that does not parse");
    }
    try {
      return parseEvent(raw);
    } catch (e) {
      if (e instanceof EventError) throw new ApiError(400, "bad_event", e.message);
      throw e;
    }
  }

  const id = (c: Context<Env>): number => {
    const n = Number(c.req.param("id"));
    if (!events.some((e) => e.id === n)) {
      throw new ApiError(404, "no_such_event", `expected a stored event id, found ${c.req.param("id")}`);
    }
    return n;
  };

  http.get("/api/events", (c) => {
    const audience = c.get("session") === undefined ? "guest" : "staff";
    return c.json({ timeZone, currency, events: upcoming(current(), { now: now(), timeZone, audience }) });
  });

  http.get("/api/events/all", (c) => {
    requirePower(c, "events.manage");
    return c.json({ timeZone, currency, events: current() });
  });

  http.post("/api/events", async (c) => {
    const session = requirePower(c, "events.manage");
    const input = await eventBody(c);
    if (current().length >= MAX_EVENTS) {
      throw new ApiError(409, "too_many_events", `expected at most ${MAX_EVENTS} events, found that many; delete one`);
    }
    const event = store.addCalendarEvent(input, session.user, now());
    events = [...events, event];
    return c.json({ event }, 201);
  });

  http.put("/api/events/:id", async (c) => {
    requirePower(c, "events.manage");
    const input = await eventBody(c);
    const n = id(c);
    store.updateCalendarEvent(n, input);
    const event = { ...input, id: n };
    events = events.map((e) => (e.id === n ? event : e));
    return c.json({ event });
  });

  http.delete("/api/events/:id", (c) => {
    requirePower(c, "events.manage");
    const n = id(c);
    store.deleteCalendarEvents([n]);
    events = events.filter((e) => e.id !== n);
    return c.json({ ok: true });
  });
}
