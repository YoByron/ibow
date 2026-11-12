/** `DD-NNN` tokens from a per-day counter. The store persists the counter; this module only computes the next one. */

export interface TokenCounter {
  /** The business-local date the counter belongs to, `YYYY-MM-DD`. */
  day: string;
  /** The last sequence number issued that day. */
  value: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The business-local calendar date of an instant, as `YYYY-MM-DD`. */
export function dayKey(now: number, timeZone: string): string {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(timeZone, f);
  }
  const parts = Object.fromEntries(f.formatToParts(now).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * The next token after `counter` (null when none was issued yet). A new business-local day restarts at 001.
 * Past 999 the sequence widens to four digits rather than wrapping, so a token is never reused in a day.
 */
export function nextToken(
  counter: TokenCounter | null,
  now: number,
  timeZone: string,
): { token: string; counter: TokenCounter } {
  const day = dayKey(now, timeZone);
  if (counter !== null) {
    if (!Number.isSafeInteger(counter.value) || counter.value < 0) {
      throw new Error(`nextToken: expected a non-negative integer counter value, found ${counter.value}`);
    }
    if (counter.day > day) {
      throw new Error(`nextToken: expected a counter from ${day} or earlier, found ${counter.day}`);
    }
  }
  const value = counter !== null && counter.day === day ? counter.value + 1 : 1;
  return { token: `${day.slice(8, 10)}-${String(value).padStart(3, "0")}`, counter: { day, value } };
}
