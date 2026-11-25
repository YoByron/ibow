/**
 * The install's own health (D-076), counted in memory and stored as one row per UTC hour, never one per request, and never
 * sent anywhere. A request adds to a few counters; the counters are written at most every `FLUSH_MS` while requests come in,
 * and once an hour with the retention pass. Eviction of a Durable Object can lose the last half minute of counts, no more.
 */

import type { MiddlewareHandler } from "hono";
import { type Health, HOUR_MS, type HourCount, healthFrom, hourOf } from "../core/health.ts";
import type { Store } from "../store/store.ts";
import type { Env } from "./errors.ts";

/** Writes to the store while requests come in: 120 a day at most per busy hour, a few hundred rows a day. */
export const FLUSH_MS = 30_000;
/** Hours kept: a week. */
const KEEP_HOURS = 24 * 7;
/** Routes kept per hour, worst first: a bound on the row. */
const ROUTES_PER_HOUR = 20;

export interface TelemetryDeps {
  store: Store;
  now: () => number;
  build: string;
  startedAt: number;
  /** Open live streams now. */
  openStreams: () => number;
  /** The newest backup the install can see, when it can see one (ms). */
  lastBackup?: () => number | undefined;
}

export interface Telemetry {
  middleware: MiddlewareHandler<Env>;
  /** Writes what is counted so far; `force` ignores the half-minute spacing. */
  flush(force?: boolean): void;
  snapshot(): HealthReport;
}

export interface HealthReport extends Health {
  build: string;
  startedAt: number;
  uptimeMs: number;
  openStreams: number;
  databaseBytes: number;
  lastBackup: { at: number; source: "backup" | "export" } | null;
  now: number;
}

/** A route as it is counted: the handler's pattern, with the files and pages that no handler names grouped. */
function routeName(method: string, pattern: string): string {
  return pattern === "/*" || pattern === "*" ? "pages and files" : `${method} ${pattern}`;
}

export function createTelemetry(deps: TelemetryDeps): Telemetry {
  const { store } = deps;
  let hour = hourOf(deps.now());
  let requests = 0;
  let errors = 0;
  let routes: HourCount["routes"] = {};
  let lastFlush = deps.now();
  let rowsBase = store.rowsWritten();

  function pending(): HourCount {
    return { hour, requests, errors, rowsWritten: store.rowsWritten() - rowsBase, routes };
  }

  function flush(force = false): void {
    const at = deps.now();
    if (!force && at - lastFlush < FLUSH_MS) return;
    lastFlush = at;
    if (requests > 0 || errors > 0) {
      const p = pending();
      const kept = Object.entries(p.routes)
        .sort((a, b) => b[1].maxMs - a[1].maxMs)
        .slice(0, ROUTES_PER_HOUR);
      // The rows this write itself costs are counted by the next flush, so none are lost.
      store.addTelemetry(p.hour, {
        requests: p.requests,
        errors: p.errors,
        rowsWritten: p.rowsWritten,
        routes: Object.fromEntries(kept),
      });
      rowsBase += p.rowsWritten;
      requests = 0;
      errors = 0;
      routes = {};
    }
    // Old hours are dropped once an hour, when the clock moves on, not at every flush.
    if (hourOf(at) !== hour) store.pruneTelemetry(hourOf(at) - KEEP_HOURS);
    hour = hourOf(at);
  }

  const middleware: MiddlewareHandler<Env> = async (c, next) => {
    // The admin's own reads of this page are not the install's load.
    if (c.req.path.startsWith("/api/admin/")) return next();
    const start = performance.now();
    let failed = false;
    try {
      await next();
      failed = c.res.status >= 500;
    } catch (e) {
      failed = true;
      throw e;
    } finally {
      const at = deps.now();
      // A new hour starts a new row: what was counted before it goes to its own hour first.
      if (hourOf(at) !== hour) flush(true);
      requests++;
      if (failed) errors++;
      const name = routeName(c.req.method, c.req.routePath);
      const ms = Math.round(performance.now() - start);
      const r = routes[name] ?? { n: 0, totalMs: 0, maxMs: 0 };
      routes[name] = { n: r.n + 1, totalMs: r.totalMs + ms, maxMs: Math.max(r.maxMs, ms) };
      flush();
    }
  };

  return {
    middleware,
    flush,
    snapshot() {
      const now = deps.now();
      const stored = store.telemetryHours(hourOf(now) - 24);
      const health = healthFrom(stored, pending(), now);
      const backup = deps.lastBackup?.();
      const exported = Number(store.meta("last_export") ?? "");
      const newest = Math.max(backup ?? 0, Number.isFinite(exported) ? exported : 0);
      return {
        ...health,
        build: deps.build,
        startedAt: deps.startedAt,
        uptimeMs: now - deps.startedAt,
        openStreams: deps.openStreams(),
        databaseBytes: store.databaseSize(),
        lastBackup: newest === 0 ? null : { at: newest, source: (backup ?? 0) >= exported ? "backup" : "export" },
        now,
      };
    },
  };
}

export { HOUR_MS };
