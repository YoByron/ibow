/** The throwaway PINs of a demo and the UPI ID it pays to; both are public by design, so neither is a secret. */

import { randomInt } from "node:crypto";

/** A UPI ID on a handle no payment app uses, so the demo's QR can never send real money anywhere. */
export const DEMO_VPA = "ibow-demo@example";

export interface DemoPins {
  owner: string;
  counter: string;
  station: string;
}

function digits(n: number): string {
  return String(randomInt(10 ** (n - 1), 10 ** n));
}

/** New PINs for one demo seed: six digits for the owner, four each for the counter and the stations. */
export function newDemoPins(): DemoPins {
  return { owner: digits(6), counter: digits(4), station: digits(4) };
}

/** The environment setting through which `npm run demo` hands its PINs to the server it starts. */
export const DEMO_PINS_ENV = "IBOW_DEMO_PINS";

/**
 * The PINs the Node demo's sign-in screens show: read only on a demo database (the seed's mark), and only when the
 * setting holds all three. A real install ignores the setting, so it can never answer `/api/demo` with a PIN.
 */
export function demoPinsFrom(env: Readonly<Record<string, string | undefined>>, isDemo: boolean): DemoPins | undefined {
  const raw = env[DEMO_PINS_ENV];
  if (!isDemo || raw === undefined) return undefined;
  try {
    const p = JSON.parse(raw) as Partial<DemoPins>;
    const ok = (v: unknown) => typeof v === "string" && /^\d{4,12}$/.test(v);
    return ok(p.owner) && ok(p.counter) && ok(p.station) ? (p as DemoPins) : undefined;
  } catch {
    return undefined;
  }
}
