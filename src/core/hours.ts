/** Opening hours as the business states them (`hours` in business.json); pure, so the storefront and tests share it. */

export interface Hours {
  /** `HH:MM`, business-local, 24 hour. */
  open: string;
  close: string;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseHours(open: unknown, close: unknown): Hours | undefined {
  if (typeof open !== "string" || typeof close !== "string" || !HHMM.test(open) || !HHMM.test(close)) return undefined;
  return { open, close };
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** Whether `at` falls inside the hours in the business's zone. Closing earlier than opening means past midnight. */
export function isOpenAt(hours: Hours, at: number, timeZone: string): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(at);
  const now = minutesOf(parts);
  const open = minutesOf(hours.open);
  const close = minutesOf(hours.close);
  if (open === close) return true;
  return open < close ? now >= open && now < close : now >= open || now < close;
}
