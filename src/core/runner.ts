/**
 * The runner's view of open orders: where each sits, how much has been carried out, what is still being made, and which
 * orders are late. Pure: time is passed in. "Late" is one number, `business.lateMinutes`, applied two ways: part of an
 * order was handed over and the rest has not followed within it, or a line has stood ready that long without being
 * carried (the cold chai and the warm latte).
 */

import type { Order } from "./orders.ts";

export type RunnerLineState = "making" | "ready" | "delivered";

export interface RunnerLine {
  index: number;
  name: string;
  qty: number;
  size?: string;
  extras?: string[];
  note?: string;
  stationId: string;
  state: RunnerLineState;
}

export type LateReason = "part-delivered" | "ready-waiting";

export interface RunnerOrder {
  id: string;
  token: string;
  spot?: string;
  customerName?: string;
  createdAt: number;
  lines: RunnerLine[];
  delivered: number;
  /** Stations whose lines are not ready yet, in line order. */
  waitingOn: string[];
  /** Lines ready and waiting to be carried out. */
  toCarry: number;
  late?: LateReason;
}

/** Open orders for the runner: late ones first, then the oldest. Completed orders are not listed. */
export function runnerOrders(orders: readonly Order[], now: number, lateMs: number): RunnerOrder[] {
  const out: RunnerOrder[] = [];
  for (const o of orders) {
    // Nothing left to carry once every line is handed over, even before the counter marks the order done.
    if (o.status === "completed" || o.lines.every((l) => l.served)) continue;
    const lines = o.lines.map((l, index): RunnerLine => {
      const state: RunnerLineState = l.served ? "delivered" : l.ready ? "ready" : "making";
      return {
        index,
        name: l.name,
        qty: l.qty,
        ...(l.size === undefined ? {} : { size: l.size }),
        ...(l.extras === undefined ? {} : { extras: l.extras.map((e) => e.name) }),
        ...(l.note === undefined ? {} : { note: l.note }),
        stationId: l.stationId,
        state,
      };
    });
    const delivered = lines.filter((l) => l.state === "delivered").length;
    const row: RunnerOrder = {
      id: o.id,
      token: o.token,
      createdAt: o.createdAt,
      lines,
      delivered,
      waitingOn: [...new Set(lines.filter((l) => l.state === "making").map((l) => l.stationId))],
      toCarry: lines.filter((l) => l.state === "ready").length,
      ...(o.spot === undefined ? {} : { spot: o.spot }),
      ...(o.customerName === undefined ? {} : { customerName: o.customerName }),
    };
    const firstServed = Math.min(...o.lines.flatMap((l) => (l.servedAt === undefined ? [] : [l.servedAt])));
    const oldestReady = Math.min(
      ...o.lines.flatMap((l) => (l.ready && !l.served && l.readyAt !== undefined ? [l.readyAt] : [])),
    );
    if (delivered > 0 && delivered < lines.length && now - firstServed > lateMs) row.late = "part-delivered";
    else if (now - oldestReady > lateMs) row.late = "ready-waiting";
    out.push(row);
  }
  return out.sort((a, b) => Number(b.late !== undefined) - Number(a.late !== undefined) || a.createdAt - b.createdAt);
}

/** Average minutes (to one decimal) between lines being ready and handed over; undefined when none were. */
export function averageCarryMinutes(totalMs: number, lines: number): number | undefined {
  return lines === 0 ? undefined : Math.round(totalMs / lines / 6000) / 10;
}
