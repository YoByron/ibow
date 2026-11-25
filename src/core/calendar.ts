/**
 * The business's events (D-084): a flea market, a folk dance every Sunday, a delivery day staff should know about. Each is
 * one day, or repeats weekly on some weekdays until an optional end date, and is shown to guests and staff or to staff only.
 * Pure: the day, the time of day and the time zone are passed in; nothing here reads the clock or the store.
 */

import { localTime } from "./insights.ts";

export type Audience = "all" | "staff";

/** What an owner or manager writes: also the shape of each entry of `events.json`. */
export interface EventInput {
  title: string;
  /** YYYY-MM-DD: the day of a one-off, or the first day a repeat may fall on. */
  date: string;
  /** HH:MM, business-local. */
  start: string;
  end?: string;
  /** One line, shown with the event ("₹700 entry", "In the garden"). */
  note?: string;
  audience: Audience;
  /** Staff should expect a rush. */
  rush: boolean;
  /** Weekly on these weekdays (0 is Sunday), up to and including `until` when given. */
  repeat?: { weekdays: number[]; until?: string };
  /** Entry price in minor units of the business currency, shown to guests; no booking, no tickets. */
  price?: number;
}

export interface CalendarEvent extends EventInput {
  id: number;
}

/** One coming occurrence of an event, as banners show it. */
export interface Occurrence extends CalendarEvent {
  /** The day it falls on. */
  day: string;
  /** 0 today, 1 tomorrow. */
  inDays: number;
  /** On its day, minutes from now to its start (negative once it has begun). */
  startsInMinutes?: number;
}

/** How far ahead banners look. */
export const WINDOW_DAYS = 7;
/** Days an event is kept after its last day, so "yesterday's market" can still be looked up, then it is deleted. */
export const KEEP_DAYS = 2;
/** At most this many events are stored: a calendar of the coming weeks, not an archive. */
export const MAX_EVENTS = 100;
export const TITLE_MAX = 60;
export const NOTE_MAX = 120;

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

const FIELDS = ["title", "date", "start", "end", "note", "audience", "rush", "repeat", "price"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** An event field is wrong: names the field, what was expected and what was found. */
export class EventError extends Error {
  readonly code = "bad_event";
  readonly field: string;
  constructor(field: string, expected: string, found: unknown, where = "") {
    super(`bad_event: ${where}${field}: expected ${expected}, found ${JSON.stringify(found) ?? "nothing"}`);
    this.name = "EventError";
    this.field = field;
  }
}

function isDay(v: unknown): v is string {
  if (typeof v !== "string" || !DAY.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

const minutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** The calendar day `k` days after `day`. */
export function addDays(day: string, k: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);
}

const weekday = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay();
const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Checks one event as written by a person or in `events.json`; `where` prefixes the field in messages. */
export function parseEvent(raw: unknown, where = ""): EventInput {
  const fail = (field: string, expected: string, found: unknown): never => {
    throw new EventError(field, expected, found, where);
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail("event", "an object", raw);
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!FIELDS.includes(k)) fail(k, `one of ${FIELDS.join(", ")}`, "an unknown field");
  const title = typeof o.title === "string" ? o.title.trim() : "";
  if (title === "" || title.length > TITLE_MAX) fail("title", `a title of 1 to ${TITLE_MAX} characters`, o.title);
  if (!isDay(o.date)) fail("date", "a date as YYYY-MM-DD", o.date);
  if (typeof o.start !== "string" || !TIME.test(o.start)) fail("start", "a time as HH:MM", o.start);
  const out: EventInput = {
    title,
    date: o.date as string,
    start: o.start as string,
    audience: "all",
    rush: false,
  };
  if (o.end !== undefined) {
    // An end before the start is the next morning (a late night that ends at 01:00); an end equal to it means nothing.
    if (typeof o.end !== "string" || !TIME.test(o.end) || minutes(o.end) === minutes(out.start)) {
      fail("end", `a time as HH:MM other than the start ${out.start} (before it is the next morning)`, o.end);
    }
    out.end = o.end as string;
  }
  if (o.note !== undefined && o.note !== "") {
    const note = typeof o.note === "string" ? o.note.trim() : undefined;
    if (note === undefined || note.length > NOTE_MAX || /[\r\n]/.test(note)) {
      fail("note", `one line of at most ${NOTE_MAX} characters`, o.note);
    }
    if (note) out.note = note;
  }
  if (o.audience !== undefined) {
    if (o.audience !== "all" && o.audience !== "staff")
      fail("audience", '"all" (guests and staff) or "staff"', o.audience);
    out.audience = o.audience as Audience;
  }
  if (o.rush !== undefined) {
    if (typeof o.rush !== "boolean") fail("rush", "true or false", o.rush);
    out.rush = o.rush as boolean;
  }
  if (o.repeat !== undefined && o.repeat !== null) {
    if (typeof o.repeat !== "object" || Array.isArray(o.repeat)) return fail("repeat", "{weekdays, until?}", o.repeat);
    const r = o.repeat as Record<string, unknown>;
    const names = Array.isArray(r.weekdays) ? r.weekdays : undefined;
    const days = names?.map((d) =>
      typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6
        ? d
        : WEEKDAYS.indexOf(String(d).toLowerCase().slice(0, 3) as (typeof WEEKDAYS)[number]),
    );
    if (days === undefined || days.length === 0 || days.some((d) => d < 0)) {
      fail("repeat.weekdays", `one or more of ${WEEKDAYS.join(", ")}`, r.weekdays);
    }
    const repeat: { weekdays: number[]; until?: string } = { weekdays: [...new Set(days)].sort((a, b) => a - b) };
    if (r.until !== undefined && r.until !== null && r.until !== "") {
      if (!isDay(r.until) || (r.until as string) < out.date) {
        fail("repeat.until", `a date as YYYY-MM-DD on or after ${out.date}`, r.until);
      }
      repeat.until = r.until as string;
    }
    out.repeat = repeat;
  }
  if (o.price !== undefined && o.price !== null) {
    if (typeof o.price !== "number" || !Number.isSafeInteger(o.price) || o.price < 0) {
      fail("price", "a whole amount in minor units, 0 or more", o.price);
    }
    out.price = o.price as number;
  }
  return out;
}

/** `events.json`: a list of events, each checked; the file and index lead every message. */
export function parseEvents(raw: unknown, file = "events.json"): EventInput[] {
  if (!Array.isArray(raw)) throw new EventError("", "a list of events", raw, `${file} `);
  return raw.map((e, i) => parseEvent(e, `${file} [${i}].`));
}

/**
 * The event's next occurrence on or after `today` that is not over at `nowMinute` (business-local): a one-off's own day,
 * or a repeat's next weekday from its first date to its end date. Over means past its end time, or past midnight without one.
 */
export function nextOccurrence(
  e: EventInput,
  today: string,
  nowMinute: number,
): { day: string; start: string; end?: string } | undefined {
  const overnight = e.end !== undefined && minutes(e.end) < minutes(e.start);
  const over = (day: string) => day === today && e.end !== undefined && !overnight && nowMinute >= minutes(e.end);
  const at = (day: string) => ({ day, start: e.start, ...(e.end === undefined ? {} : { end: e.end }) });
  // Last night's occurrence of an event that ends past midnight is still on until its end this morning.
  const yesterday = addDays(today, -1);
  if (overnight && nowMinute < minutes(e.end as string) && occursOn(e, yesterday)) return at(yesterday);
  if (e.repeat === undefined) return e.date < today || over(e.date) ? undefined : at(e.date);
  let day = e.date > today ? e.date : today;
  for (let i = 0; i < 8; i++, day = addDays(day, 1)) {
    if (e.repeat.until !== undefined && day > e.repeat.until) return undefined;
    if (e.repeat.weekdays.includes(weekday(day)) && !over(day)) return at(day);
  }
  return undefined;
}

/** Whether the event falls on `day`: a one-off's own day, or a repeat's weekday between its first and end dates. */
function occursOn(e: EventInput, day: string): boolean {
  if (e.repeat === undefined) return day === e.date;
  if (day < e.date || (e.repeat.until !== undefined && day > e.repeat.until)) return false;
  return e.repeat.weekdays.includes(weekday(day));
}

/**
 * The events in the next `WINDOW_DAYS` days (today included) that `audience` may see, each at its next occurrence,
 * soonest first. Guests see only events for guests; staff (any signed-in level) see every one.
 */
export function upcoming(
  events: readonly CalendarEvent[],
  opts: { now: number; timeZone: string; audience: "guest" | "staff"; days?: number },
): Occurrence[] {
  const t = localTime(opts.now, opts.timeZone);
  const nowMinute = t.hour * 60 + t.minute;
  const out: Occurrence[] = [];
  for (const e of events) {
    if (opts.audience === "guest" && e.audience !== "all") continue;
    const next = nextOccurrence(e, t.day, nowMinute);
    if (next === undefined) continue;
    // Last night's late event, still on, counts as today's: it began a day's minutes earlier.
    const days = daysBetween(t.day, next.day);
    const inDays = Math.max(0, days);
    if (inDays > (opts.days ?? WINDOW_DAYS)) continue;
    out.push({
      ...e,
      day: next.day,
      inDays,
      ...(inDays === 0 ? { startsInMinutes: minutes(e.start) - nowMinute + days * 1440 } : {}),
    });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.start.localeCompare(b.start) || a.id - b.id);
}

/** Whether an event can go: `KEEP_DAYS` after a one-off's day or a repeat's end date. An open-ended repeat stays. */
export function expired(e: EventInput, today: string): boolean {
  const last = e.repeat === undefined ? e.date : e.repeat.until;
  return last !== undefined && daysBetween(last, today) > KEEP_DAYS;
}
