/** Per-station totals of open items, and the spoken batch text built from a template. */

import type { Order } from "./orders.ts";

export interface BatchLine {
  itemId: string;
  name: string;
  size?: string;
  qty: number;
}

export interface Batch {
  stationId: string;
  /** Tokens of open orders with at least one unserved line for this station, in the given order. */
  tokens: string[];
  /** Totals per item and size, in order of first appearance. */
  lines: BatchLine[];
}

/**
 * Placeholders: `batch` takes {tokens} and {items}; `item` takes {qty}, {name} and {size}. Runs of spaces left by an
 * empty placeholder (an item with no size) collapse to one.
 */
export interface BatchTemplate {
  batch: string;
  tokenSeparator: string;
  item: string;
  itemSeparator: string;
  empty: string;
}

export const BATCH_TEMPLATES: Readonly<Record<string, BatchTemplate>> = {
  // The live app's format: "Tokens 05-001, 05-002 12 Item One M, 3 Item Two S, 1 Item Three".
  en: {
    batch: "Tokens {tokens} {items}",
    tokenSeparator: ", ",
    item: "{qty} {name} {size}",
    itemSeparator: ", ",
    empty: "Nothing to prepare",
  },
};

/** What a batch needs of an order; a station's own view of an order is enough. */
export type BatchSource = Pick<Order, "token" | "status" | "lines">;

/** Open means the order is pending or preparing and the line is neither ready nor served. Pass orders in token order. */
export function openBatch(orders: readonly BatchSource[], stationId: string): Batch {
  const tokens: string[] = [];
  const totals = new Map<string, BatchLine>();
  for (const order of orders) {
    if (order.status === "completed") continue;
    let contributes = false;
    for (const line of order.lines) {
      if (line.stationId !== stationId || line.served || line.ready) continue;
      contributes = true;
      const key = `${line.itemId}|${line.size ?? ""}`;
      const prev = totals.get(key);
      if (prev) prev.qty += line.qty;
      else
        totals.set(key, {
          itemId: line.itemId,
          name: line.name,
          ...(line.size === undefined ? {} : { size: line.size }),
          qty: line.qty,
        });
    }
    if (contributes) tokens.push(order.token);
  }
  return { stationId, tokens, lines: [...totals.values()] };
}

const PLACEHOLDERS = ["tokens", "items", "qty", "name", "size"];

function fill(template: string, values: Record<string, string>): string {
  return template
    .replace(/\{(\w+)\}/g, (match, key: string) => {
      const value = values[key];
      if (value === undefined) {
        throw new Error(`renderBatch: expected one of ${PLACEHOLDERS.map((p) => `{${p}}`).join(", ")}, found ${match}`);
      }
      return value;
    })
    .replace(/ {2,}/g, " ")
    .trim();
}

export function renderBatch(batch: Batch, template: BatchTemplate): string {
  if (batch.lines.length === 0) return template.empty;
  const items = batch.lines
    .map((l) => fill(template.item, { qty: String(l.qty), name: l.name, size: l.size ?? "" }))
    .join(template.itemSeparator);
  return fill(template.batch, { tokens: batch.tokens.join(template.tokenSeparator), items });
}

/** The batch as shown on screen: the same text with a separator between the tokens and the items. */
export function displayBatch(batch: Batch, template: BatchTemplate): string {
  return renderBatch(batch, { ...template, batch: template.batch.replace("{tokens} {items}", "{tokens} · {items}") });
}

export interface BatchRow {
  size?: string;
  qty: number;
  /** Tokens of the open orders that want this item and size, oldest first. */
  tokens: string[];
}

export interface BatchGroup {
  itemId: string;
  name: string;
  total: number;
  rows: BatchRow[];
}

/** The same open lines as `openBatch`, grouped by item with one row per size and the tokens each row serves. */
export function groupBatch(orders: readonly BatchSource[], stationId: string): BatchGroup[] {
  const groups = new Map<string, BatchGroup>();
  for (const order of orders) {
    if (order.status === "completed") continue;
    for (const line of order.lines) {
      if (line.stationId !== stationId || line.served || line.ready) continue;
      const group = groups.get(line.itemId) ?? { itemId: line.itemId, name: line.name, total: 0, rows: [] };
      groups.set(line.itemId, group);
      let row = group.rows.find((r) => r.size === line.size);
      if (row === undefined) {
        row = { ...(line.size === undefined ? {} : { size: line.size }), qty: 0, tokens: [] };
        group.rows.push(row);
      }
      row.qty += line.qty;
      group.total += line.qty;
      if (!row.tokens.includes(order.token)) row.tokens.push(order.token);
    }
  }
  return [...groups.values()];
}
