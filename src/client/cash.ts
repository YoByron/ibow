/** Cash at the counter: the "received" amounts to offer as one-tap buttons, and the change to hand back. Pure. */

import { minorExponent } from "../core/money.ts";

const SERIES = [1, 2, 5];
const SUGGESTED = 4;

/** The next notes up: 1-2-5 steps of the currency's major unit, each above `dueMinor`. */
function notesAbove(dueMinor: number, currency: string): number[] {
  const out: number[] = [];
  for (let unit = 10 ** minorExponent(currency); out.length < SUGGESTED; unit *= 10) {
    for (const s of SERIES) if (s * unit > dueMinor && out.length < SUGGESTED) out.push(s * unit);
  }
  return out;
}

/**
 * The exact amount first, then the business's own shortcuts (`cashShortcuts` in business.json) that cover what is due;
 * when none is set or none covers it, the next notes up. All in minor units.
 */
export function cashOptions(dueMinor: number, currency: string, shortcutsMinor?: readonly number[]): number[] {
  const covering = (shortcutsMinor ?? []).filter((m) => m > dueMinor);
  const rest = covering.length > 0 ? [...new Set(covering)].sort((a, b) => a - b) : notesAbove(dueMinor, currency);
  return [dueMinor, ...rest];
}

/** What to hand back; negative means the customer has not handed over enough yet. */
export function changeDue(receivedMinor: number, dueMinor: number): number {
  return receivedMinor - dueMinor;
}
