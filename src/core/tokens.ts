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

/**
 * What a person reads and hears: the order number, `#47` for the token `25-047` (M13). The day stays in the token,
 * which keeps it unique across days; people only ever deal with today's orders, where the number alone is unique.
 * Anything that isn't a `DD-NNN` token is returned as it is.
 */
export function orderNumber(token: string): string {
  const m = /^\d{2}-(\d{3,})$/.exec(token);
  return m ? `#${Number(m[1])}` : token;
}

/** Every `DD-NNN` token inside `text` as its order number (for lists such as "25-001, 25-002"). */
export function orderNumbers(text: string): string {
  return text.replace(/\b\d{2}-(\d{3,})\b/g, (_, n: string) => `#${Number(n)}`);
}

/**
 * The token a person typed, on business day `day` (YYYY-MM-DD): a full `DD-NNN` stays as it is; a bare order number such
 * as `47` or `#47` becomes that day's token, `25-047`. Undefined for anything else.
 */
export function tokenForNumber(input: string, day: string): string | undefined {
  const text = input.trim();
  if (/^\d{2}-\d{3,}$/.test(text)) return text;
  const m = /^#?(\d{1,5})$/.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isSafeInteger(n) || n < 1) return undefined;
  return `${day.slice(8, 10)}-${String(n).padStart(3, "0")}`;
}
