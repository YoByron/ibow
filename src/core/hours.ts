/** Opening hours as the business states them (`hours` in business.json); pure, so the storefront and tests share it. */

export interface Hours {
  /** `HH:MM`, business-local, 24 hour. */
  open: string;
  close: string;
  /** `HH:MM`: customers' orders stop after it, though the doors stay open until `close`. Absent: orders follow the hours. */
  lastOrder?: string;
  /** Weekdays the business stays shut all day (`"mon"` … `"sun"`), business-local. Absent: open every day. */
  closedDays?: Weekday[];
}

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** The business-local weekday of `at`. */
export function weekdayAt(at: number, timeZone: string): Weekday {
  const short = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone }).format(at).toLowerCase().slice(0, 3);
  return short as Weekday;
}

/** The business-local calendar day of `at`, as YYYY-MM-DD. */
function localDay(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

const addDays = (day: string, k: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);

/**
 * The business day `at` belongs to: its calendar day, except that the hours after midnight of a business open past
 * midnight (18:00 to 02:00) belong to the day it opened.
 */
function businessDay(hours: Hours, at: number, timeZone: string): string {
  const day = localDay(at, timeZone);
  const open = minutesOf(hours.open);
  const close = minutesOf(hours.close);
  return close < open && localMinutes(at, timeZone) < close ? addDays(day, -1) : day;
}

const weekdayOf = (day: string): Weekday => WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()] as Weekday;

/** The weekday of the business day `at` belongs to (Monday 01:00 of a business open until 02:00 is Sunday's). */
export function businessWeekday(hours: Hours, at: number, timeZone: string): Weekday {
  return weekdayOf(businessDay(hours, at, timeZone));
}

/** Whether `at` falls on one of the business's closed days: the business day it belongs to, past midnight included. */
export function closedDayAt(hours: Hours, at: number, timeZone: string): boolean {
  return hours.closedDays?.includes(weekdayOf(businessDay(hours, at, timeZone))) ?? false;
}

/** The instant of `minute` past midnight on `day` in `timeZone` (settled in two passes over a clock change). */
function instantOf(day: string, minute: number, timeZone: string): number {
  let guess = Date.parse(`${day}T00:00:00Z`) + minute * 60_000;
  for (let i = 0; i < 3; i++) {
    const shift =
      (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${localDay(guess, timeZone)}T00:00:00Z`)) / 60_000 +
      (minute - localMinutes(guess, timeZone));
    if (shift === 0) break;
    guess += shift * 60_000;
  }
  return guess;
}

/**
 * When the business next opens on a day that is not a closed day: `at` itself when today's business day is open, else
 * the opening time of the next open day. Days are counted on the calendar, never as 24 hours, so a clock change can't
 * skip one.
 */
export function nextOpenDay(hours: Hours, at: number, timeZone: string): number {
  const today = businessDay(hours, at, timeZone);
  for (let d = 0; d < 7; d++) {
    const day = addDays(today, d);
    if (hours.closedDays?.includes(weekdayOf(day))) continue;
    return d === 0 ? at : instantOf(day, minutesOf(hours.open), timeZone);
  }
  return at;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseHours(
  open: unknown,
  close: unknown,
  lastOrder?: unknown,
  closedDays?: unknown,
): Hours | undefined {
  if (typeof open !== "string" || typeof close !== "string" || !HHMM.test(open) || !HHMM.test(close)) return undefined;
  let days: Weekday[] | undefined;
  if (closedDays !== undefined) {
    const valid = (d: unknown): d is Weekday => typeof d === "string" && (WEEKDAYS as readonly string[]).includes(d);
    // Every day closed would be a business that never opens: a mistake, not a schedule.
    if (!Array.isArray(closedDays) || !closedDays.every(valid) || new Set(closedDays).size >= 7) return undefined;
    days = [...new Set(closedDays)];
  }
  const withDays = (h: Hours): Hours => (days === undefined || days.length === 0 ? h : { ...h, closedDays: days });
  if (lastOrder === undefined) return withDays({ open, close });
  if (typeof lastOrder !== "string" || !HHMM.test(lastOrder)) return undefined;
  // Counted from opening, the last order must fall within the open stretch.
  const since = (x: string) => (minutesOf(x) - minutesOf(open) + 1440) % 1440;
  const span = since(close) === 0 ? 1440 : since(close);
  if (since(lastOrder) > span) return undefined;
  return withDays({ open, close, lastOrder });
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

function localMinutes(at: number, timeZone: string): number {
  return minutesOf(
    new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(at),
  );
}

/**
 * Whether the storefront takes an order now: always without a `lastOrder`; with one, from opening until that time.
 * (Without a last-order time the hours are only what the page says, as before.)
 */
export function takesOrdersAt(hours: Hours, at: number, timeZone: string): boolean {
  if (closedDayAt(hours, at, timeZone)) return false;
  if (hours.lastOrder === undefined) return true;
  const since = (x: number) => (x - minutesOf(hours.open) + 1440) % 1440;
  return since(localMinutes(at, timeZone)) <= since(minutesOf(hours.lastOrder));
}

/** Whether `at` falls inside the hours in the business's zone. Closing earlier than opening means past midnight. */
export function isOpenAt(hours: Hours, at: number, timeZone: string): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(at);
  if (closedDayAt(hours, at, timeZone)) return false;
  const now = minutesOf(parts);
  const open = minutesOf(hours.open);
  const close = minutesOf(hours.close);
  if (open === close) return true;
  return open < close ? now >= open && now < close : now >= open || now < close;
}
