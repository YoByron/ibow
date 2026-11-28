/**
 * Guest messages (D-104): a guest asks their runner something on their own order ("water", "the bill, please", a short
 * line), the runner answers in one tap or a short line. Pure: limits, routing and what counts as unanswered. A quick
 * chip is kept as its code, so each side reads it in its own language; free text is the only part retention clears.
 */

import type { Zone } from "./config.ts";
import type { Runners } from "./floor.ts";
import type { Order } from "./orders.ts";
import { sectionOf } from "./sections.ts";

export const GUEST_CHIPS = ["water", "bill", "help", "more"] as const;
export const STAFF_CHIPS = ["coming", "twoMinutes"] as const;
export type GuestChip = (typeof GUEST_CHIPS)[number];
export type StaffChip = (typeof STAFF_CHIPS)[number];

export interface OrderMessage {
  at: number;
  from: "guest" | "staff";
  /** A short line typed by its sender; cleared after `retentionDays`, like a note. */
  text?: string;
  chip?: GuestChip | StaffChip;
  /** A guest's message: the staff id it was sent to, the runner of the spot's section; absent, every runner and the counter. */
  to?: string;
  /** A reply: the staff id who sent it, for staff only. */
  by?: string;
}

export const MAX_MESSAGE_CHARS = 200;
export const MAX_GUEST_MESSAGES = 20;
/** Every guest message can be answered, so the thread holds twice the guest's share. */
export const MAX_THREAD = 2 * MAX_GUEST_MESSAGES;
/** One guest message per this long on an order. */
export const GUEST_GAP_MS = 10_000;
/** A completed order still takes a guest's message this long after it closed ("the bill, please" after the last dish). */
export const CLOSED_WINDOW_MS = 30 * 60_000;

export type MessageErrorCode = "bad_message" | "too_many_messages" | "too_soon" | "messages_closed";

export class MessageError extends Error {
  readonly code: MessageErrorCode;
  /** For `too_soon`: whole seconds until the next message is accepted. */
  readonly retryAfterS?: number;
  constructor(code: MessageErrorCode, message: string, retryAfterS?: number) {
    super(message);
    this.name = "MessageError";
    this.code = code;
    if (retryAfterS !== undefined) this.retryAfterS = retryAfterS;
  }
}

export interface MessageInput {
  text?: unknown;
  chip?: unknown;
}

function body(input: MessageInput, chips: readonly string[]): Pick<OrderMessage, "text" | "chip"> {
  const hasText = input.text !== undefined && input.text !== null;
  const hasChip = input.chip !== undefined && input.chip !== null;
  if (hasText === hasChip) {
    throw new MessageError("bad_message", `expected either text or a chip, found ${hasText ? "both" : "neither"}`);
  }
  if (hasChip) {
    if (typeof input.chip !== "string" || !chips.includes(input.chip)) {
      throw new MessageError(
        "bad_message",
        `expected a chip of ${chips.join(", ")}, found ${JSON.stringify(input.chip)}`,
      );
    }
    return { chip: input.chip as GuestChip | StaffChip };
  }
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (text === "") throw new MessageError("bad_message", "expected a message with some text, found none");
  if ([...text].length > MAX_MESSAGE_CHARS) {
    throw new MessageError(
      "bad_message",
      `expected at most ${MAX_MESSAGE_CHARS} characters, found ${[...text].length}`,
    );
  }
  return { text };
}

/** When a completed order closed: its last change to completed, else when it was placed. Undefined while it is open. */
export function closedAt(order: Order): number | undefined {
  if (order.status !== "completed") return undefined;
  return order.history.findLast((h) => h.to === "completed")?.at ?? order.createdAt;
}

/** Until when a guest may still message on this order: set only once it is completed. */
export function messagesUntil(order: Order): number | undefined {
  const closed = closedAt(order);
  return closed === undefined ? undefined : closed + CLOSED_WINDOW_MS;
}

/** The order with a guest's message added, sent to `to` (a staff id, or undefined for everyone). Throws `MessageError`. */
export function guestMessage(order: Order, input: MessageInput, now: number, to: string | undefined): Order {
  const until = messagesUntil(order);
  if (until !== undefined && now > until) {
    throw new MessageError(
      "messages_closed",
      `expected an open order or one completed within ${CLOSED_WINDOW_MS / 60_000} minutes, found one completed at ${new Date(until - CLOSED_WINDOW_MS).toISOString()}; please ask at the counter`,
    );
  }
  const thread = order.messages ?? [];
  const mine = thread.filter((m) => m.from === "guest");
  if (mine.length >= MAX_GUEST_MESSAGES) {
    throw new MessageError(
      "too_many_messages",
      `expected at most ${MAX_GUEST_MESSAGES} messages from a guest on one order, found ${mine.length} already; please ask at the counter`,
    );
  }
  const last = mine.at(-1);
  if (last !== undefined && now - last.at < GUEST_GAP_MS) {
    const wait = Math.ceil((GUEST_GAP_MS - (now - last.at)) / 1000);
    throw new MessageError(
      "too_soon",
      `expected one message per ${GUEST_GAP_MS / 1000} seconds, found the last ${now - last.at} ms ago`,
      wait,
    );
  }
  const message: OrderMessage = {
    at: now,
    from: "guest",
    ...body(input, GUEST_CHIPS),
    ...(to === undefined ? {} : { to }),
  };
  return { ...order, messages: [...thread, message] };
}

/** The order with a staff member's reply added. Throws `MessageError`. */
export function staffReply(order: Order, input: MessageInput, now: number, by: string): Order {
  const thread = order.messages ?? [];
  if (thread.length >= MAX_THREAD) {
    throw new MessageError(
      "too_many_messages",
      `expected at most ${MAX_THREAD} messages on one order, found ${thread.length}`,
    );
  }
  return { ...order, messages: [...thread, { at: now, from: "staff", ...body(input, STAFF_CHIPS), by }] };
}

/** Whether the guest's last message has no reply after it. */
export function unanswered(order: { messages?: readonly OrderMessage[] | undefined }): boolean {
  return order.messages?.at(-1)?.from === "guest";
}

/** Who a guest's message goes to: the runner of the order's section today, or undefined (every runner and the counter). */
export function messageTo(
  order: Pick<Order, "spot" | "spotId">,
  zones: readonly Zone[],
  runners: Runners,
): string | undefined {
  const section = sectionOf(order, zones);
  return section === undefined ? undefined : runners[section];
}
