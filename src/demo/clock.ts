/** The server's clock, which a demo may fix for screenshots (D-054). */
import { localTime } from "../core/insights.ts";

/** The instant, in ms since the epoch, the demo's clock stands at; read only when the database is a demo's. */
export const DEMO_NOW_ENV = "IBOW_DEMO_NOW";

export interface ServerClock {
  now: () => number;
  /** The setting was present but this is not a demo database, so it was ignored (the server says so at boot). */
  ignored: boolean;
}

/**
 * The clock the server runs on: the real one, except on a demo database (`isDemo`: the seed's mark, which a real
 * install never has) with `IBOW_DEMO_NOW` set, where time stands still at that instant. A real install ignores the
 * setting whatever it holds, so no stray environment variable can freeze a business's clock.
 */
export function serverClock(env: Readonly<Record<string, string | undefined>>, isDemo: boolean): ServerClock {
  const raw = env[DEMO_NOW_ENV];
  if (raw === undefined || raw === "") return { now: Date.now, ignored: false };
  if (!isDemo) return { now: Date.now, ignored: true };
  const at = Number(raw);
  if (!Number.isInteger(at) || at < 0) {
    throw new Error(
      `ibow: expected ${DEMO_NOW_ENV} to be a time in milliseconds since 1970, found ${JSON.stringify(raw)}`,
    );
  }
  return { now: () => at, ignored: false };
}

/** The instant at `hour`:`minute` on the business day of `zone` that `at` falls in (not the UTC day, which differs by hours). */
export function instantOn(zone: string, at: number, hour: number, minute: number): number {
  const want = hour * 60 + minute;
  const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / 86_400_000;
  const today = localTime(at, zone).day;
  let guess = Date.parse(`${today}T00:00:00Z`) + want * 60_000;
  // The guess is off by the zone's offset; each pass moves it by the days and minutes still between it and the target.
  for (let i = 0; i < 4; i++) {
    const t = localTime(guess, zone);
    const diff = (dayNumber(today) - dayNumber(t.day)) * 1440 + (want - (t.hour * 60 + t.minute));
    if (diff === 0) break;
    guess += diff * 60_000;
  }
  return guess;
}
