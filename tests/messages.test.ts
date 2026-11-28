import { describe, expect, test } from "vitest";
import {
  CLOSED_WINDOW_MS,
  GUEST_GAP_MS,
  guestMessage,
  MAX_GUEST_MESSAGES,
  MAX_MESSAGE_CHARS,
  MAX_THREAD,
  MessageError,
  messageTo,
  staffReply,
  unanswered,
} from "../src/core/messages.ts";
import { createOrder, type Order } from "../src/core/orders.ts";
import { customerView } from "../src/core/views.ts";
import { loadSample } from "./support/samples.ts";

const cafe = loadSample("garden-cafe");
const t0 = Date.UTC(2026, 11, 1, 11, 0);

function placed(spotId = "garden-t4"): Order {
  return createOrder(cafe, { id: "o1", token: "01-001", now: t0, spotId, lines: [{ itemId: "carrot-cake", qty: 1 }] });
}

function refused(run: () => unknown): MessageError {
  try {
    run();
  } catch (e) {
    if (e instanceof MessageError) return e;
    throw e;
  }
  throw new Error("expected a MessageError, found none");
}

describe("guest messages (D-104)", () => {
  test("a guest's message is kept with who it went to; a chip is kept as its code, not as text", () => {
    let o = guestMessage(placed(), { text: "  Could we get a high chair?  " }, t0 + 1000, "asha");
    o = guestMessage(o, { chip: "water" }, t0 + 1000 + GUEST_GAP_MS, undefined);
    expect(o.messages).toEqual([
      { at: t0 + 1000, from: "guest", text: "Could we get a high chair?", to: "asha" },
      { at: t0 + 1000 + GUEST_GAP_MS, from: "guest", chip: "water" },
    ]);
    expect(unanswered(o)).toBe(true);
  });

  test("a staff reply answers the thread and records who replied; the guest never sees a staff id", () => {
    const asked = guestMessage(placed(), { chip: "bill" }, t0, "asha");
    const replied = staffReply(asked, { chip: "coming" }, t0 + 5000, "asha");
    expect(unanswered(replied)).toBe(false);
    expect(replied.messages?.at(-1)).toEqual({ at: t0 + 5000, from: "staff", chip: "coming", by: "asha" });
    const seen = customerView(replied).messages;
    expect(seen).toEqual([
      { at: t0, from: "guest", chip: "bill" },
      { at: t0 + 5000, from: "staff", chip: "coming" },
    ]);
    expect(JSON.stringify(customerView(replied))).not.toContain("asha");
    // A new guest message after the reply is unanswered again.
    expect(unanswered(guestMessage(replied, { text: "thanks" }, t0 + GUEST_GAP_MS, undefined))).toBe(true);
    expect(unanswered(placed())).toBe(false);
  });

  test("text is 1 to 200 characters, or one known chip, never both", () => {
    expect(refused(() => guestMessage(placed(), { text: "   " }, t0, undefined)).code).toBe("bad_message");
    expect(
      refused(() => guestMessage(placed(), { text: "x".repeat(MAX_MESSAGE_CHARS + 1) }, t0, undefined)).message,
    ).toMatch(/at most 200/);
    expect(refused(() => guestMessage(placed(), { chip: "coming" }, t0, undefined)).code).toBe("bad_message");
    expect(refused(() => guestMessage(placed(), { text: "a", chip: "water" }, t0, undefined)).code).toBe("bad_message");
    expect(refused(() => staffReply(placed(), { chip: "water" }, t0, "asha")).code).toBe("bad_message");
    expect(guestMessage(placed(), { text: "x".repeat(MAX_MESSAGE_CHARS) }, t0, undefined).messages).toHaveLength(1);
  });

  test("one guest message per 10 seconds on an order", () => {
    const o = guestMessage(placed(), { chip: "help" }, t0, undefined);
    const e = refused(() => guestMessage(o, { chip: "help" }, t0 + GUEST_GAP_MS - 1, undefined));
    expect(e.code).toBe("too_soon");
    expect(e.retryAfterS).toBe(1);
    // Staff replies are not rate-limited.
    expect(
      staffReply(staffReply(o, { chip: "coming" }, t0 + 1, "a"), { text: "on the way" }, t0 + 2, "a").messages,
    ).toHaveLength(3);
  });

  test("at most 20 from the guest, and the thread stays bounded with room for staff to answer", () => {
    let o = placed();
    for (let i = 0; i < MAX_GUEST_MESSAGES; i++)
      o = guestMessage(o, { chip: "water" }, t0 + i * GUEST_GAP_MS, undefined);
    const e = refused(() => guestMessage(o, { chip: "water" }, t0 + 99 * GUEST_GAP_MS, undefined));
    expect(e.code).toBe("too_many_messages");
    expect(e.message).toMatch(/at most 20/);
    // The runner can still answer every one of them.
    for (let i = MAX_GUEST_MESSAGES; i < MAX_THREAD; i++) o = staffReply(o, { chip: "coming" }, t0 + i, "a");
    expect(refused(() => staffReply(o, { chip: "coming" }, t0, "a")).code).toBe("too_many_messages");
  });

  test("a completed order takes messages for a short window after it closed, then refuses with when it closed", () => {
    const o = placed();
    const done: Order = {
      ...o,
      status: "completed",
      history: [
        { from: "pending", to: "preparing", at: t0 + 60_000 },
        { from: "preparing", to: "completed", at: t0 + 120_000 },
      ],
    };
    expect(guestMessage(done, { chip: "bill" }, t0 + 120_000 + CLOSED_WINDOW_MS, undefined).messages).toHaveLength(1);
    const e = refused(() => guestMessage(done, { chip: "bill" }, t0 + 120_001 + CLOSED_WINDOW_MS, undefined));
    expect(e.code).toBe("messages_closed");
    expect(e.message).toMatch(/30 minutes/);
    expect(customerView(done).messagesUntil).toBe(t0 + 120_000 + CLOSED_WINDOW_MS);
    expect(customerView(o).messagesUntil).toBeUndefined();
  });
});

describe("routing (D-104)", () => {
  test("to the runner of the spot's section; to nobody in particular when the section has none or the order no spot", () => {
    expect(messageTo(placed("garden-t4"), cafe.zones, { garden: "asha", terrace: "ravi" })).toBe("asha");
    expect(messageTo(placed("terrace-1"), cafe.zones, { garden: "asha" })).toBeUndefined();
    const walkIn = createOrder(cafe, {
      id: "o2",
      token: "01-002",
      now: t0,
      lines: [{ itemId: "carrot-cake", qty: 1 }],
    });
    expect(messageTo(walkIn, cafe.zones, { garden: "asha" })).toBeUndefined();
  });
});
