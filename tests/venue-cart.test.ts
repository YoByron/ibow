import { expect, test } from "vitest";
import { addOne, cartFromLines, cartTotal, itemQty, setNoteAt, setQtyAt } from "../src/client/cart.ts";
import { priceOfLine, type StoreCatalog } from "../src/client/catalog.ts";
import { parseCatalog } from "../src/core/config.ts";
import { readSample } from "./support/samples.ts";

const catalog = {
  business: { name: "x", currency: "EUR", timeZone: "UTC", maxQtyPerLine: 9 },
  payments: { upi: false },
  ...parseCatalog(readSample("garden-cafe", "catalog.json")),
} as StoreCatalog;

test("lines with different extras or notes stay apart, and the same ones merge", () => {
  let cart = addOne([], "latte", "Large", 9, { extras: ["oat-milk"] });
  cart = addOne(cart, "latte", "Large", 9, { extras: ["oat-milk"] });
  cart = addOne(cart, "latte", "Large", 9);
  cart = addOne(cart, "latte", "Large", 9, { note: "extra hot" });
  expect(cart.map((l) => l.qty)).toEqual([2, 1, 1]);
  expect(itemQty(cart, "latte")).toBe(4);
});

test("the cart total prices extras, and a note that matches another line merges into it", () => {
  const cart = addOne([], "latte", "Large", 9, { extras: ["oat-milk", "extra-shot"] });
  expect(priceOfLine(catalog, "latte", "Large", ["oat-milk", "extra-shot"])).toBe(580);
  expect(cartTotal(setQtyAt(cart, 0, 2, 9), (i, s, e) => priceOfLine(catalog, i, s, e))).toBe(1160);
  let two = addOne(cart, "latte", "Large", 9, { extras: ["oat-milk", "extra-shot"], note: "hot" });
  two = setNoteAt(two, 1, "", 9);
  expect(two).toHaveLength(1);
  expect(two[0]?.qty).toBe(2);
  expect(cartFromLines(two, 9)).toEqual(two);
});

test("a spot's QR opens the storefront with that spot set, whatever its id holds", async () => {
  const { spotLink } = await import("../src/client/owner-spots.ts");
  expect(spotLink("https://cafe.example", "garden-t4")).toBe("https://cafe.example/?spot=garden-t4");
  expect(spotLink("https://cafe.example", "a&b c")).toBe("https://cafe.example/?spot=a%26b%20c");
  expect(spotLink("https://cafe.example", "rooms-3", "k_y-Z")).toBe("https://cafe.example/?spot=rooms-3&key=k_y-Z");
});

test("lines that would merge past the cap stay two, so no units are dropped", () => {
  let cart = addOne([], "latte", "Large", 3, { extras: ["oat-milk"] });
  cart = setQtyAt(cart, 0, 2, 3);
  cart = addOne(cart, "latte", "Large", 3, { extras: ["oat-milk"], note: "hot" });
  cart = setQtyAt(cart, 1, 2, 3);
  const after = setNoteAt(cart, 1, "", 3);
  expect(after.map((l) => l.qty)).toEqual([2, 2]);
  expect(itemQty(after, "latte")).toBe(4);
  expect(after[1]?.note).toBeUndefined();
});
