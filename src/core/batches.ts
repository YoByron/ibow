/** Per-station totals of open items, and the spoken batch text built from a template. */

import type { Order, OrderLine } from "./orders.ts";
import { orderNumber } from "./tokens.ts";

export interface BatchLine {
  itemId: string;
  name: string;
  size?: string;
  /** Names of the extras on these lines, in catalog order. Lines differing in extras or note are separate rows. */
  extras?: string[];
  note?: string;
  qty: number;
}

/** What makes two open lines one row of a batch: the same item, size, extras and note. */
function variantKey(line: OrderLine): string {
  return `${line.itemId}|${line.size ?? ""}|${(line.extras ?? []).map((e) => e.id).join(",")}|${line.note ?? ""}`;
}

function variantOf(line: OrderLine): { extras?: string[]; note?: string } {
  return {
    ...(line.extras === undefined ? {} : { extras: line.extras.map((e) => e.name) }),
    ...(line.note === undefined ? {} : { note: line.note }),
  };
}

export interface Batch {
  stationId: string;
  /** Tokens of open orders with at least one unserved line for this station, in the given order. */
  tokens: string[];
  /** Where each of those orders sits, by token; only orders with a spot are listed (D-073). */
  spots?: Record<string, string>;
  /** Totals per item and size, in order of first appearance. */
  lines: BatchLine[];
}

/**
 * Placeholders: `batch` takes {tokens} and {items}; `item` takes {qty}, {name}, {size}, {extras} (names joined by " + ")
 * and {note} (in brackets). Runs of spaces left by an
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
  // People hear order numbers, never tokens (M13): "Orders #1, #2 12 Item One M, 3 Item Two S, 1 Item Three".
  en: {
    batch: "Orders {tokens} {items}",
    tokenSeparator: ", ",
    item: "{qty} {name} {size} {extras} {note}",
    itemSeparator: ", ",
    empty: "Nothing to prepare",
  },
};

/** What a batch needs of an order; a station's own view of an order is enough. */
export type BatchSource = Pick<Order, "token" | "status" | "lines"> & { spot?: string | undefined };

/** Open means the order is pending or preparing and the line is neither ready nor served. Pass orders in token order. */
export function openBatch(orders: readonly BatchSource[], stationId: string): Batch {
  const tokens: string[] = [];
  const spots: Record<string, string> = {};
  const totals = new Map<string, BatchLine>();
  for (const order of orders) {
    if (order.status === "completed") continue;
    let contributes = false;
    for (const line of order.lines) {
      if (line.stationId !== stationId || line.served || line.ready) continue;
      contributes = true;
      const key = variantKey(line);
      const prev = totals.get(key);
      if (prev) prev.qty += line.qty;
      else
        totals.set(key, {
          itemId: line.itemId,
          name: line.name,
          ...(line.size === undefined ? {} : { size: line.size }),
          ...variantOf(line),
          qty: line.qty,
        });
    }
    if (contributes) {
      tokens.push(order.token);
      if (order.spot !== undefined) spots[order.token] = order.spot;
    }
  }
  return { stationId, tokens, ...(Object.keys(spots).length === 0 ? {} : { spots }), lines: [...totals.values()] };
}

const PLACEHOLDERS = ["tokens", "items", "qty", "name", "size", "extras", "note"];

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
    .map((l) =>
      fill(template.item, {
        qty: String(l.qty),
        name: l.name,
        size: l.size ?? "",
        extras: (l.extras ?? []).join(" + "),
        note: l.note === undefined ? "" : `(${l.note})`,
      }),
    )
    .join(template.itemSeparator);
  // A token is followed by where that order sits, so what is read out says where to carry it.
  const tokens = batch.tokens.map((tk) =>
    batch.spots?.[tk] === undefined ? orderNumber(tk) : `${orderNumber(tk)} ${batch.spots[tk]}`,
  );
  return fill(template.batch, { tokens: tokens.join(template.tokenSeparator), items });
}

/** The batch as shown on screen: the same text with a separator between the tokens and the items. */
export function displayBatch(batch: Batch, template: BatchTemplate): string {
  return renderBatch(batch, { ...template, batch: template.batch.replace("{tokens} {items}", "{tokens} · {items}") });
}

export interface BatchRow {
  size?: string;
  extras?: string[];
  note?: string;
  qty: number;
  /** Tokens of the open orders that want this item and size, oldest first. */
  tokens: string[];
  /** Where those orders sit, by token (only orders with a spot). */
  spots?: Record<string, string>;
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
  const rowKeys = new Map<BatchRow, string>();
  for (const order of orders) {
    if (order.status === "completed") continue;
    for (const line of order.lines) {
      if (line.stationId !== stationId || line.served || line.ready) continue;
      const group = groups.get(line.itemId) ?? { itemId: line.itemId, name: line.name, total: 0, rows: [] };
      groups.set(line.itemId, group);
      let row = group.rows.find((r) => rowKeys.get(r) === variantKey(line));
      if (row === undefined) {
        row = {
          ...(line.size === undefined ? {} : { size: line.size }),
          ...variantOf(line),
          qty: 0,
          tokens: [],
        };
        rowKeys.set(row, variantKey(line));
        group.rows.push(row);
      }
      row.qty += line.qty;
      group.total += line.qty;
      if (!row.tokens.includes(order.token)) row.tokens.push(order.token);
      if (order.spot !== undefined) {
        row.spots ??= {};
        row.spots[order.token] = order.spot;
      }
    }
  }
  return [...groups.values()];
}
