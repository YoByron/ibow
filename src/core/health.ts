/**
 * What the admin reads to answer "is this install healthy" (D-076): hourly counts folded into a day's picture. Pure. The
 * counts are kept on the install, one row per UTC hour, and never sent anywhere.
 */

export const HOUR_MS = 3_600_000;
/** What the Cloudflare free plan allows a Durable Object per day (docs/decisions.md, D-076). */
export const FREE_ROWS_WRITTEN_PER_DAY = 100_000;
export const FREE_DB_BYTES = 1_000_000_000;

export interface RouteCount {
  n: number;
  totalMs: number;
  maxMs: number;
}

export interface HourCount {
  hour: number;
  requests: number;
  errors: number;
  rowsWritten: number;
  routes: Record<string, RouteCount>;
}

export interface Health {
  /** The last 24 hours, oldest first, empty hours included; `hour` is the hour's start in ms. */
  hours: { at: number; requests: number; errors: number }[];
  requests: number;
  errors: number;
  /** The routes with the worst single time in those 24 hours, worst first. */
  slowest: { route: string; n: number; avgMs: number; maxMs: number }[];
  rows: { writtenToday: number; limit: number; dayStart: number };
}

/** The hour number (hours since the epoch, UTC) of a time. */
export const hourOf = (at: number): number => Math.floor(at / HOUR_MS);

const SLOWEST_SHOWN = 5;

/**
 * Folds the stored hours and this process's not yet stored counts (`pending`) into one picture at `now`. Rows written
 * today count from 00:00 UTC, when Cloudflare starts a new day for its limits.
 */
export function healthFrom(stored: readonly HourCount[], pending: HourCount | undefined, now: number): Health {
  const byHour = new Map<number, HourCount>();
  for (const h of [...stored, ...(pending === undefined ? [] : [pending])]) {
    const had = byHour.get(h.hour);
    if (had === undefined) {
      byHour.set(h.hour, { ...h, routes: { ...h.routes } });
      continue;
    }
    had.requests += h.requests;
    had.errors += h.errors;
    had.rowsWritten += h.rowsWritten;
    for (const [name, r] of Object.entries(h.routes)) {
      const x = had.routes[name];
      had.routes[name] =
        x === undefined ? r : { n: x.n + r.n, totalMs: x.totalMs + r.totalMs, maxMs: Math.max(x.maxMs, r.maxMs) };
    }
  }
  const current = hourOf(now);
  const hours: Health["hours"] = [];
  const routes = new Map<string, RouteCount>();
  let requests = 0;
  let errors = 0;
  for (let hour = current - 23; hour <= current; hour++) {
    const h = byHour.get(hour);
    hours.push({ at: hour * HOUR_MS, requests: h?.requests ?? 0, errors: h?.errors ?? 0 });
    requests += h?.requests ?? 0;
    errors += h?.errors ?? 0;
    for (const [name, r] of Object.entries(h?.routes ?? {})) {
      const x = routes.get(name);
      routes.set(
        name,
        x === undefined
          ? { ...r }
          : { n: x.n + r.n, totalMs: x.totalMs + r.totalMs, maxMs: Math.max(x.maxMs, r.maxMs) },
      );
    }
  }
  const slowest = [...routes]
    .map(([route, r]) => ({ route, n: r.n, avgMs: Math.round(r.totalMs / r.n), maxMs: r.maxMs }))
    .sort((a, b) => b.maxMs - a.maxMs || b.avgMs - a.avgMs || a.route.localeCompare(b.route))
    .slice(0, SLOWEST_SHOWN);
  const dayStart = Math.floor(now / (24 * HOUR_MS)) * 24 * HOUR_MS;
  let writtenToday = 0;
  for (const h of byHour.values()) if (h.hour * HOUR_MS >= dayStart) writtenToday += h.rowsWritten;
  return { hours, requests, errors, slowest, rows: { writtenToday, limit: FREE_ROWS_WRITTEN_PER_DAY, dayStart } };
}

export type Concern = "errors" | "rows" | "size";

/**
 * The one-line answer: healthy, or what to look at. More than 2% of the last 24 hours' requests ending in a server error
 * (once there are 50 of them to judge by), 80% of the day's free rows written, or 80% of the free storage used.
 */
export function verdict(health: Health, databaseBytes: number): { ok: boolean; concerns: Concern[] } {
  const concerns: Concern[] = [];
  if (health.requests >= 50 && health.errors / health.requests > 0.02) concerns.push("errors");
  if (health.rows.writtenToday > 0.8 * health.rows.limit) concerns.push("rows");
  if (databaseBytes > 0.8 * FREE_DB_BYTES) concerns.push("size");
  return { ok: concerns.length === 0, concerns };
}
