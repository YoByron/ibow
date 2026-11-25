/**
 * Runs the store's retention (`forgetCustomers`) once at startup and then every `everyMs`, so customer names and review
 * text never outlive `retentionDays` by more than one interval. The clock is passed in, so tests drive it.
 */

import { localTime } from "../core/insights.ts";
import type { ForgetResult, Store } from "../store/store.ts";

const DAY_MS = 86_400_000;
/** How long the replay log is kept: a client offline longer reloads its snapshot instead (D-041). */
export const EVENT_WINDOW_MS = 2 * DAY_MS;

export interface RetentionOptions {
  store: Store;
  /** Days before names, review text and notes go; a function so the admin's switch applies at the next pass. */
  days: number | (() => number);
  now: () => number;
  /** The business's time zone, so finished days can be totalled; without it only retention and pruning run. */
  timeZone?: string;
  /** Default one hour. */
  everyMs?: number;
  onRun?: (result: ForgetResult) => void;
}

/** Starts the schedule; the returned function stops it. */
export function startRetention(opts: RetentionOptions): () => void {
  const run = () => {
    const days = typeof opts.days === "function" ? opts.days() : opts.days;
    const result = opts.store.forgetCustomers(opts.now() - days * DAY_MS);
    opts.store.pruneEvents(opts.now() - EVENT_WINDOW_MS);
    // Every finished day not yet totalled, oldest first (D-044); a Node process can afford all of them at once.
    if (opts.timeZone !== undefined) {
      const today = localTime(opts.now(), opts.timeZone).day;
      while (opts.store.closeNextDay(today, opts.timeZone) !== undefined) {
        // one day per call
      }
    }
    opts.onRun?.(result);
  };
  run();
  const timer = setInterval(run, opts.everyMs ?? 60 * 60_000);
  // Never keeps the process alive on its own.
  timer.unref?.();
  return () => clearInterval(timer);
}
