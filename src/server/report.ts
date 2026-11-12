/**
 * Builds the owner's report for an instant (D-044 to D-046). Today is aggregated in SQL each time; every finished day is
 * frozen once closed, so it is read once and kept in memory: yesterday in full (and "yesterday so far" from its
 * per-minute record) and the older days the forecast averages over. A recompute therefore costs one day's SQL, not three.
 */

import {
  addDays,
  type DayRecord,
  forecastDays,
  localTime,
  type Report,
  recordUpTo,
  reportFromDays,
  statsFromSales,
} from "../core/insights.ts";
import type { Store } from "../store/store.ts";

export function createReportBuilder(store: Store, timeZone: string): (at: number) => Report {
  /** Finished days already read, by day; a day is frozen (D-045) so one read is for good. */
  const finished = new Map<string, DayRecord | null>();
  const finishedDay = (day: string): DayRecord | undefined => {
    if (!finished.has(day)) finished.set(day, store.closeDay(day, timeZone) ?? null);
    return finished.get(day) ?? undefined;
  };
  return (at) => {
    const t = localTime(at, timeZone);
    const yesterday = addDays(t.day, -1);
    const yesterdayRecord = finishedDay(yesterday);
    const empty = statsFromSales([], yesterday, timeZone);
    const closed = new Map<string, DayRecord>();
    for (const day of forecastDays(at, timeZone).filter((d) => d < yesterday)) {
      const record = finishedDay(day);
      if (record !== undefined) closed.set(day, record);
    }
    return reportFromDays(
      {
        today: store.dayStats(t.day, timeZone, { full: true }),
        yesterdaySoFar: yesterdayRecord === undefined ? empty : recordUpTo(yesterdayRecord, t.hour * 60 + t.minute),
        yesterday: yesterdayRecord ?? empty,
        closed,
      },
      at,
      timeZone,
    );
  };
}
