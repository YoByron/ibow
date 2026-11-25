import { describe, expect, test } from "vitest";
import {
  BATCH_TEMPLATES,
  type BatchTemplate,
  displayBatch,
  groupBatch,
  openBatch,
  renderBatch,
} from "../src/core/batches.ts";
import { advanceStatus, createOrder, markReady, markServed } from "../src/core/orders.ts";
import { loadSample } from "./support/samples.ts";

const config = loadSample("tea-house");
const t0 = Date.UTC(2026, 10, 26, 12, 0);
const en = BATCH_TEMPLATES.en as BatchTemplate;

function orders() {
  const a = createOrder(config, {
    id: "a",
    token: "26-001",
    now: t0,
    lines: [
      { itemId: "house-special-chai", size: "M", qty: 7 },
      { itemId: "veg-crunchy-momos", qty: 1 },
    ],
  });
  const b = createOrder(config, {
    id: "b",
    token: "26-002",
    now: t0 + 1000,
    lines: [
      { itemId: "house-special-chai", size: "M", qty: 5 },
      { itemId: "rose-tea", size: "S", qty: 2 },
      { itemId: "cold-coffee", qty: 1 },
    ],
  });
  const c = createOrder(config, {
    id: "c",
    token: "26-003",
    now: t0 + 2000,
    lines: [{ itemId: "salted-fries", qty: 2 }],
  });
  return [a, b, c];
}

describe("batches", () => {
  test("tea batch text matches the live app's format", () => {
    const batch = openBatch(orders(), "tea");
    expect(renderBatch(batch, en)).toBe("Orders #1, #2 12 House Special Chai M, 2 Rose Tea S, 1 Cold Coffee");
  });

  test("a station sees only its own items, and only tokens that have some", () => {
    const batch = openBatch(orders(), "kitchen");
    expect(batch.tokens).toEqual(["26-001", "26-003"]);
    expect(renderBatch(batch, en)).toBe("Orders #1, #3 1 Veg Crunchy Momos, 2 Salted Fries");
  });

  test("served lines and completed orders drop out; preparing orders stay", () => {
    const [a, b, c] = orders();
    if (!a || !b || !c) throw new Error("fixture");
    const list = [markServed(a, 0), advanceStatus(b, t0), advanceStatus(advanceStatus(c, t0), t0)];
    expect(renderBatch(openBatch(list, "tea"), en)).toBe(
      "Orders #2 5 House Special Chai M, 2 Rose Tea S, 1 Cold Coffee",
    );
    expect(renderBatch(openBatch(list, "kitchen"), en)).toBe("Orders #1 1 Veg Crunchy Momos");
  });

  test("lines marked ready drop out, like served ones", () => {
    const [a, b, c] = orders();
    if (!a || !b || !c) throw new Error("fixture");
    const list = [markReady(a, "tea", [0]), b, c];
    expect(renderBatch(openBatch(list, "tea"), en)).toBe(
      "Orders #2 5 House Special Chai M, 2 Rose Tea S, 1 Cold Coffee",
    );
  });

  test("an empty batch says so", () => {
    expect(renderBatch(openBatch([], "tea"), en)).toBe("Nothing to prepare");
  });

  test("text comes from the template, so another language is config", () => {
    const hi: BatchTemplate = {
      batch: "ऑर्डर {tokens}: {items}",
      tokenSeparator: ", ",
      item: "{name} {size} {qty}",
      itemSeparator: "; ",
      empty: "कुछ नहीं",
    };
    expect(renderBatch(openBatch(orders(), "kitchen"), hi)).toBe("ऑर्डर #1, #3: Veg Crunchy Momos 1; Salted Fries 2");
  });

  test("an unknown placeholder fails loudly", () => {
    expect(() => renderBatch(openBatch(orders(), "tea"), { ...en, item: "{qty} {colour}" })).toThrow(
      "expected one of {tokens}, {items}, {qty}, {name}, {size}, {extras}, {note}, found {colour}",
    );
  });
});

describe("the station's grouped view", () => {
  test("groups by item with a row per size: its count and the tokens that want it", () => {
    const groups = groupBatch(orders(), "tea");
    const chai = groups.find((g) => g.itemId === "house-special-chai");
    expect(chai?.total).toBe(12);
    expect(chai?.rows).toEqual([{ size: "M", qty: 12, tokens: ["26-001", "26-002"] }]);
    const rose = groups.find((g) => g.itemId === "rose-tea");
    expect(rose?.rows).toEqual([{ size: "S", qty: 2, tokens: ["26-002"] }]);
    // Totals agree with the batch the speech is made from.
    const batch = openBatch(orders(), "tea");
    expect(groups.reduce((n, g) => n + g.total, 0)).toBe(batch.lines.reduce((n, l) => n + l.qty, 0));
  });

  test("an item with sizes has one row each, and a size-less item one row without a size", () => {
    const o = createOrder(config, {
      id: "d",
      token: "26-004",
      now: t0,
      lines: [
        { itemId: "house-special-chai", size: "M", qty: 1 },
        { itemId: "house-special-chai", size: "L", qty: 3 },
      ],
    });
    const groups = groupBatch([o], "tea");
    expect(groups[0]?.rows.map((r) => [r.size, r.qty])).toEqual([
      ["M", 1],
      ["L", 3],
    ]);
    const fries = groupBatch(orders(), "kitchen").find((g) => g.itemId === "salted-fries");
    expect(fries?.rows).toEqual([{ qty: 2, tokens: ["26-003"] }]);
  });

  test("the displayed text separates the tokens from the items; the spoken text keeps the original format", () => {
    const batch = openBatch(orders(), "tea");
    expect(renderBatch(batch, en)).toMatch(/^Orders #1, #2 12 House Special Chai M, /);
    expect(displayBatch(batch, en)).toMatch(/^Orders #1, #2 · 12 House Special Chai M, /);
    expect(displayBatch({ stationId: "tea", tokens: [], lines: [] }, en)).toBe("Nothing to prepare");
  });
});

describe("spots on a station's batch (D-073)", () => {
  const withSpots = () => orders().map((o, i) => (i === 0 ? { ...o, spot: "Garden T4" } : o));

  test("each row says where its orders sit, and what is read out says it too", () => {
    const list = withSpots();
    const chai = groupBatch(list, "tea").find((g) => g.itemId === "house-special-chai");
    expect(chai?.rows[0]?.spots).toEqual({ "26-001": "Garden T4" });
    expect(renderBatch(openBatch(list, "tea"), en)).toMatch(/^Orders #1 Garden T4, #2 12 House Special Chai M/);
  });

  test("without spots nothing changes: no spots keys, the same text", () => {
    const batch = openBatch(orders(), "tea");
    expect(batch.spots).toBeUndefined();
    expect(groupBatch(orders(), "tea").every((g) => g.rows.every((r) => r.spots === undefined))).toBe(true);
  });
});
