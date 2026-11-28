/**
 * The floor (D-103): which orders are a runner's own, and every section as a block of its spots coloured by what is
 * happening there. Pure: it works on the runner's rows (`runnerOrders`, which already knows what is ready and late), the
 * layout in force, and the day's runners by section.
 */

import type { Zone } from "./config.ts";
import type { RunnerOrder } from "./runner.ts";
import { sectionOf } from "./sections.ts";

/** Section id to the staff id running it today; a section with nobody is absent. */
export type Runners = Readonly<Record<string, string>>;

/**
 * A runner's own orders first: those in the sections given to them, and those in a section with nobody (or no known
 * section), so no order is ever orphaned. The rest are other runners'. Each part keeps the rows' order.
 */
export function mineFirst<T extends Pick<RunnerOrder, "spotId" | "spot">>(
  rows: readonly T[],
  zones: readonly Zone[],
  runners: Runners,
  user: string,
): { mine: T[]; rest: T[] } {
  const mine: T[] = [];
  const rest: T[] = [];
  for (const r of rows) {
    const section = sectionOf(r, zones);
    const runner = section === undefined ? undefined : runners[section];
    (runner === undefined || runner === user ? mine : rest).push(r);
  }
  return { mine, rest };
}

/** `message` is a guest's message nobody has answered yet (filled in by guest messages, D-104). */
export type SpotState = "free" | "ordered" | "ready" | "late" | "message";

export interface FloorSpot {
  id: string;
  label: string;
  state: SpotState;
  /** The open orders at this spot, by id, in the rows' order. */
  orders: string[];
}

export interface FloorSection {
  id: string;
  name: string;
  kind?: "room";
  runner?: string;
  spots: FloorSpot[];
}

const RANK: Record<SpotState, number> = { free: 0, ordered: 1, ready: 2, late: 3, message: 4 };

/**
 * Every section in layout order with its spots, each coloured by the most urgent of its open orders: an unanswered
 * message, then late, then ready to carry, then ordered; free when it has none.
 */
export function floorState(
  zones: readonly Zone[],
  rows: readonly RunnerOrder[],
  runners: Runners,
  unanswered: ReadonlySet<string> = new Set(),
): FloorSection[] {
  const bySpot = new Map<string, RunnerOrder[]>();
  for (const z of zones) {
    for (const s of z.spots) {
      const here = rows.filter((r) => (r.spotId === undefined ? r.spot === s.label : r.spotId === s.id));
      if (here.length > 0) bySpot.set(s.id, here);
    }
  }
  return zones.map((z) => {
    const runner = runners[z.id];
    return {
      id: z.id,
      name: z.name,
      ...(z.kind === undefined ? {} : { kind: z.kind }),
      ...(runner === undefined ? {} : { runner }),
      spots: z.spots.map((s): FloorSpot => {
        const here = bySpot.get(s.id) ?? [];
        let state: SpotState = "free";
        for (const r of here) {
          const own: SpotState = unanswered.has(r.id)
            ? "message"
            : r.late !== undefined
              ? "late"
              : r.toCarry > 0
                ? "ready"
                : "ordered";
          if (RANK[own] > RANK[state]) state = own;
        }
        return { id: s.id, label: s.label, state, orders: here.map((r) => r.id) };
      }),
    };
  });
}
