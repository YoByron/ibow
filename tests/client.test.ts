import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { adminEn } from "../src/client/admin-strings.ts";
import { addOne, cartFromLines, cartTotal, itemCount, qtyOf, setQty } from "../src/client/cart.ts";
import { priceOf, visibleCategories } from "../src/client/catalog.ts";
import { eventsEn } from "../src/client/events-strings.ts";
import { analystEn } from "../src/client/owner-ai-strings.ts";
import { ownerEn } from "../src/client/owner-strings.ts";
import { qrPath } from "../src/client/qr.ts";
import { loadOrder, memoryStore, newClientKey, saveOrder } from "../src/client/session.ts";
import { staffEn } from "../src/client/staff-strings.ts";
import { en, t } from "../src/client/strings.ts";
import { pluralForm } from "../src/core/plural.ts";
import { loadSample } from "./support/samples.ts";

const tea = loadSample("tea-house").catalog.categories;
const truck = loadSample("food-truck").catalog.categories;
const clientDir = new URL("../src/client/", import.meta.url);
const clientFiles = (pattern: RegExp) =>
  readdirSync(clientDir)
    .filter((f) => pattern.test(f))
    .map((f) => ({ file: f, src: readFileSync(new URL(f, clientDir), "utf8") }));

describe("storefront catalog", () => {
  test("hides unavailable items and drops categories left empty", () => {
    const ids = visibleCategories(truck).flatMap((c) => c.items.map((i) => i.id));
    expect(ids).not.toContain("corn-on-the-cob");
    expect(ids.length).toBe(truck.flatMap((c) => c.items).length - 1);
    expect(priceOf(truck, "corn-on-the-cob")).toBeUndefined();
  });

  test("search matches every word in the item or category name, ignoring case and accents", () => {
    const found = visibleCategories(tea, "COLD rose").flatMap((c) => c.items.map((i) => i.name));
    expect(found).toEqual(["Cold Rose Tea"]);
    expect(visibleCategories(tea, "tea / coffee").map((c) => c.id)).toEqual(["tea-coffee"]);
    const cafe = [{ id: "c", name: "Drinks", items: [{ id: "x", name: "Café", price: 1 }] }];
    expect(visibleCategories(cafe, "cafe")).toHaveLength(1);
    expect(visibleCategories(tea, "no such thing")).toEqual([]);
  });

  test("narrows to one category and prices variants by size", () => {
    expect(visibleCategories(tea, "", "tea-coffee").map((c) => c.id)).toEqual(["tea-coffee"]);
    expect(priceOf(tea, "house-special-chai", "M")).toBe(3000);
    expect(priceOf(tea, "house-special-chai")).toBeUndefined();
    expect(priceOf(tea, "veg-momos-sf")).toBe(6000);
    expect(priceOf(tea, "veg-momos-sf", "M")).toBeUndefined();
  });
});

describe("cart", () => {
  test("adds, sets and removes lines, keeping each size apart and each quantity within the cap", () => {
    let cart = addOne([], "house-special-chai", "M", 3);
    cart = addOne(cart, "house-special-chai", "M", 3);
    cart = addOne(cart, "house-special-chai", "L", 3);
    expect(cart).toEqual([
      { itemId: "house-special-chai", size: "M", qty: 2 },
      { itemId: "house-special-chai", size: "L", qty: 1 },
    ]);
    cart = setQty(cart, "house-special-chai", "M", 10, 3);
    expect(qtyOf(cart, "house-special-chai", "M")).toBe(3);
    expect(addOne(cart, "house-special-chai", "M", 3)).toEqual(cart);
    cart = setQty(cart, "house-special-chai", "L", 0, 3);
    expect(cart).toEqual([{ itemId: "house-special-chai", size: "M", qty: 3 }]);
    expect(setQty([], "veg-momos-sf", undefined, 0, 3)).toEqual([]);
    expect(itemCount(cart)).toBe(3);
    expect(cartTotal(cart, (id, size) => priceOf(tea, id, size))).toBe(9000);
  });

  test("rebuilds from an order's lines for an edit, merging repeats", () => {
    const lines = [
      { itemId: "veg-momos-sf", qty: 1 },
      { itemId: "house-special-chai", size: "S", qty: 2 },
      { itemId: "veg-momos-sf", qty: 2 },
    ];
    expect(cartFromLines(lines, 99)).toEqual([
      { itemId: "veg-momos-sf", qty: 3 },
      { itemId: "house-special-chai", size: "S", qty: 2 },
    ]);
  });
});

describe("client credentials", () => {
  test("the client key is 128 random bits in base64url, which the server's pattern accepts", () => {
    const keys = new Set(Array.from({ length: 200 }, newClientKey));
    expect(keys.size).toBe(200);
    for (const k of keys) expect(k).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  test("an order reference round-trips and a corrupt one is ignored", () => {
    const kv = memoryStore();
    expect(loadOrder(kv)).toBeUndefined();
    saveOrder(kv, { id: "o1", key: "secret" });
    expect(loadOrder(kv)).toEqual({ id: "o1", key: "secret" });
    kv.set("ibow.order", "{not json");
    expect(loadOrder(kv)).toBeUndefined();
  });

  test("the order key goes in a header on fetch; only the EventSource URL carries it", () => {
    for (const { file, src } of clientFiles(/\.ts$/)) {
      const inUrl = [...src.matchAll(/key=\$\{/g)].length;
      // A room's key is printed in its QR by design (D-082): it is not an order key.
      expect(inUrl, file).toBe(file === "live.ts" || file === "owner-spots.ts" ? 1 : 0);
    }
  });
});

describe("strings and rendering", () => {
  test("fills placeholders and leaves unknown ones visible", () => {
    expect(t("editFor", { left: "1:05" })).toBe("Change order (1:05 left)");
    expect(t("editFor")).toContain("{left}");
  });

  test("every string key used in the client exists, and none is unused", () => {
    /** A plural form (`itemsCount_one`) is used when its general text is. */
    const baseKey = (key: string) => pluralForm(key)?.base ?? key;
    const keysIn = (src: string) => new Set([...src.matchAll(/\btn?\("([A-Za-z]+)"/g)].map((m) => m[1]));
    const files = clientFiles(/\.ts$/).filter(({ file }) => !/strings\.ts$/.test(file));
    const staffFiles = new Set([
      "staff.ts",
      "print.ts",
      "staff-refund.ts",
      "staff-manager.ts",
      "staff-rooms.ts",
      "staff-floor.ts",
      "staff-sections.ts",
      "staff-thread.ts",
    ]);
    const ownerFiles = new Set(["owner.ts", "owner-view.ts", "owner-appearance.ts", "owner-spots.ts"]);
    const owner = keysIn(
      files
        .filter(({ file }) => ownerFiles.has(file))
        .map(({ src }) => src)
        .join("\n"),
    );
    // The owner's dashboard has its own table only.
    for (const key of owner) expect(Object.keys(ownerEn), `missing owner string ${key}`).toContain(key);
    for (const key of Object.keys(ownerEn)) expect(owner.has(baseKey(key)), `unused owner string ${key}`).toBe(true);
    // The AI analyst's panel (M7) has its own table too.
    const analyst = keysIn(files.find(({ file }) => file === "owner-ai.ts")?.src ?? "");
    for (const key of analyst) expect(Object.keys(analystEn), `missing analyst string ${key}`).toContain(key);
    for (const key of Object.keys(analystEn))
      expect(analyst.has(baseKey(key)), `unused analyst string ${key}`).toBe(true);
    // The events editor, on the owner's tab and the manager's screen, has its own table (D-084).
    const editor = new Set(
      files.flatMap(({ src }) => [...src.matchAll(/\bte\("([A-Za-z]+)"/g)].map((m) => m[1] as string)),
    );
    for (const key of editor) expect(Object.keys(eventsEn), `missing events string ${key}`).toContain(key);
    for (const key of Object.keys(eventsEn)) expect(editor.has(key), `unused events string ${key}`).toBe(true);
    // The links hub, switches and health page have their own table as well (D-074).
    const admin = keysIn(files.find(({ file }) => file === "admin.ts")?.src ?? "");
    for (const key of admin) expect(Object.keys(adminEn), `missing admin string ${key}`).toContain(key);
    for (const key of Object.keys(adminEn)) expect(admin.has(baseKey(key)), `unused admin string ${key}`).toBe(true);
    const store = keysIn(
      files
        .filter(
          ({ file }) => !staffFiles.has(file) && !ownerFiles.has(file) && file !== "owner-ai.ts" && file !== "admin.ts",
        )
        .map(({ src }) => src)
        .join("\n"),
    );
    const staff = keysIn(
      files
        .filter(({ file }) => staffFiles.has(file))
        .map(({ src }) => src)
        .join("\n"),
    );
    // The storefront uses only its own table; the staff screens may use both.
    for (const key of store) expect(Object.keys(en), `missing string ${key}`).toContain(key);
    for (const key of staff) expect([...Object.keys(en), ...Object.keys(staffEn)], `missing ${key}`).toContain(key);
    for (const key of Object.keys(en))
      expect(store.has(baseKey(key)) || staff.has(baseKey(key)), `unused string ${key}`).toBe(true);
    for (const key of Object.keys(staffEn)) expect(staff.has(baseKey(key)), `unused staff string ${key}`).toBe(true);
    for (const key of Object.keys(staffEn)) expect(Object.keys(en), `${key} in both tables`).not.toContain(key);
  });

  test("the client never parses text as HTML and never hard-codes a currency symbol", () => {
    for (const { file, src } of clientFiles(/\.(ts|html)$/)) {
      expect(src, file).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser/);
      expect(src, file).not.toMatch(/[₹€£¥]|\$(?=\d)/u);
    }
  });

  test("the QR for a UPI intent is a square of modules with the finder pattern in the corner", () => {
    const { size, d } = qrPath("upi://pay?pa=teahouse@example&pn=The%20Tea%20House&am=60&cu=INR&tn=Token%2026-001");
    expect(size).toBeGreaterThanOrEqual(21 + 2);
    // A one-module border, then the top-left finder pattern starts dark.
    expect(d.startsWith("M1 1h1v1h-1z")).toBe(true);
  });
});
