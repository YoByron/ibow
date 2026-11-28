import { describe, expect, test } from "vitest";
import { floorState, mineFirst } from "../src/core/floor.ts";
import { guestMessage, staffReply } from "../src/core/messages.ts";
import { createOrder, markReady, markServed, type Order } from "../src/core/orders.ts";
import { runnerOrders } from "../src/core/runner.ts";
import { loadSample } from "./support/samples.ts";

const cafe = loadSample("garden-cafe");
const MIN = 60_000;
const t0 = 1_000_000;
const lateMs = 6 * MIN;
let n = 0;

function at(spotId: string | undefined, now = t0): Order {
  n++;
  return createOrder(cafe, {
    id: `o${n}`,
    token: `01-${String(n).padStart(3, "0")}`,
    now,
    ...(spotId === undefined ? {} : { spotId }),
    lines: [
      { itemId: "carrot-cake", qty: 1 },
      { itemId: "mango-smoothie", qty: 1 },
    ],
  });
}

describe("mineFirst (D-103)", () => {
  test("my sections and sections with nobody are mine; the rest are someone else's", () => {
    const garden = at("garden-t1");
    const terrace = at("terrace-2");
    const other = at("other-hammock");
    const away = at(undefined);
    const rows = runnerOrders([garden, terrace, other, away], t0, lateMs);
    const { mine, rest } = mineFirst(rows, cafe.zones, { garden: "asha", terrace: "ravi" }, "asha");
    expect(mine.map((r) => r.id)).toEqual([garden.id, other.id, away.id]);
    expect(rest.map((r) => r.id)).toEqual([terrace.id]);
  });

  test("an order whose spot was deleted since shows to everyone, so none is orphaned", () => {
    const rows = runnerOrders([{ ...at("garden-t1"), spotId: "gone-1", spot: "Gone 1" }], t0, lateMs);
    expect(mineFirst(rows, cafe.zones, { garden: "ravi" }, "asha").mine).toHaveLength(1);
  });
});

describe("floorState (D-103)", () => {
  test("each section is a block of its spots, coloured free, ordered, ready to carry or late, with its runner", () => {
    const ordered = at("garden-t1");
    const ready = markReady(at("garden-t2"), "cakes", [0], t0 + 8 * MIN);
    // Part handed over long ago and the rest not following: late.
    const late = markServed(markReady(at("garden-t3"), "cakes", [0], t0), 0, t0 + MIN);
    const rows = runnerOrders([ordered, ready, late], t0 + 10 * MIN, lateMs);
    const floor = floorState(cafe.zones, rows, { garden: "asha" });
    const garden = floor.find((s) => s.id === "garden");
    expect(garden?.runner).toBe("asha");
    expect(garden?.spots.slice(0, 4).map((s) => s.state)).toEqual(["ordered", "ready", "late", "free"]);
    expect(garden?.spots[0]?.orders).toEqual([ordered.id]);
    expect(floor.find((s) => s.id === "terrace")?.runner).toBeUndefined();
    expect(floor.map((s) => s.id)).toEqual(["garden", "terrace", "other", "rooms"]);
  });

  test("an unanswered guest message outranks every other state (filled by guest messages)", () => {
    const late = markServed(markReady(at("terrace-1"), "cakes", [0], t0), 0, t0 + MIN);
    const rows = runnerOrders([late], t0 + 10 * MIN, lateMs);
    const spot = floorState(cafe.zones, rows, {}, new Set([late.id])).find((s) => s.id === "terrace")?.spots[0];
    expect(spot?.state).toBe("message");
  });

  test("an order taken before spot ids were kept is placed by its label", () => {
    const { spotId: _gone, ...old } = at("other-hammock");
    const rows = runnerOrders([old], t0, lateMs);
    expect(floorState(cafe.zones, rows, {}).find((s) => s.id === "other")?.spots[0]?.state).toBe("ordered");
  });
});

describe("guest messages on the runner and the floor (D-104)", () => {
  test("a runner row carries the thread and whether it waits for an answer; an answered one is not flagged", () => {
    const asked = guestMessage(at("garden-t2"), { chip: "water" }, t0, "asha");
    const [row] = runnerOrders([asked], t0, lateMs);
    expect(row?.unanswered).toBe(true);
    expect(row?.messages).toEqual(asked.messages);
    const [answered] = runnerOrders([staffReply(asked, { chip: "coming" }, t0 + 1, "asha")], t0, lateMs);
    expect(answered?.unanswered).toBeUndefined();
  });

  test("an order with everything handed over stays on the runner while its guest waits for an answer", () => {
    let o = at("garden-t3");
    o = markServed(markServed(o, 0, t0), 1, t0);
    expect(runnerOrders([o], t0, lateMs)).toEqual([]);
    const asked = guestMessage(o, { chip: "bill" }, t0 + MIN, undefined);
    expect(runnerOrders([asked], t0 + MIN, lateMs).map((r) => r.id)).toEqual([o.id]);
    const done = guestMessage({ ...o, status: "completed" as const }, { chip: "bill" }, t0 + MIN, undefined);
    expect(runnerOrders([done], t0 + MIN, lateMs).map((r) => r.id)).toEqual([o.id]);
    // The floor colours its spot as a message.
    const rows = runnerOrders([asked], t0 + MIN, lateMs);
    const unanswered = new Set(rows.filter((r) => r.unanswered).map((r) => r.id));
    expect(floorState(cafe.zones, rows, {}, unanswered).find((s) => s.id === "garden")?.spots[2]?.state).toBe(
      "message",
    );
  });
});

describe("counter-first on the runner (D-101)", () => {
  test("an order still waiting for the counter's confirmation is shown as awaiting payment, until it is paid", () => {
    const unpaid: Order = { ...at("garden-t6"), paysFirst: true };
    const [row] = runnerOrders([unpaid], t0, lateMs);
    expect(row?.awaitingPayment).toBe(true);
    const paid: Order = {
      ...unpaid,
      payment: { state: "confirmed", method: "cash", amountMinor: 1, at: t0, by: "till" },
    };
    expect(runnerOrders([paid], t0, lateMs)[0]?.awaitingPayment).toBeUndefined();
    expect(runnerOrders([at("garden-t7")], t0, lateMs)[0]?.awaitingPayment).toBeUndefined();
  });
});
