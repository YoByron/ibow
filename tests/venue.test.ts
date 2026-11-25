import { describe, expect, test } from "vitest";
import { BATCH_TEMPLATES, type BatchTemplate, groupBatch, openBatch, renderBatch } from "../src/core/batches.ts";
import { ConfigError, extraGroupsFor, loadConfig, parseCatalog, parseSpots, stationFor } from "../src/core/config.ts";
import { createOrder, markReady, markServed, NOTE_MAX, OrderError, orderTotal } from "../src/core/orders.ts";
import { customerView, stationView } from "../src/core/views.ts";
import { loadSample, readSample, sampleRaw } from "./support/samples.ts";

const cafe = loadSample("garden-cafe");
const en = BATCH_TEMPLATES.en as BatchTemplate;
const base = { id: "o1", token: "01-001", now: 1_000 };
const order = (lines: Parameters<typeof createOrder>[1]["lines"], more: { spotId?: string } = {}) =>
  createOrder(cafe, { ...base, lines, ...more });

// biome-ignore lint/suspicious/noExplicitAny: a test edits parsed JSON by path
type Json = Record<string, any>;

function catalogWith(edit: (c: Json) => void): unknown {
  const catalog = structuredClone(readSample("garden-cafe", "catalog.json")) as Json;
  edit(catalog);
  return catalog;
}

describe("spots", () => {
  test("a zone is a count with a prefix, or a list of names; each spot label says its zone", () => {
    const zones = parseSpots([
      { id: "garden", name: "Garden", prefix: "T", count: 2 },
      { id: "other", name: "Elsewhere", spots: ["Hammock", "Bench by the gate"] },
    ]);
    expect(zones.flatMap((z) => z.spots)).toEqual([
      { id: "garden-t1", label: "Garden T1" },
      { id: "garden-t2", label: "Garden T2" },
      { id: "other-hammock", label: "Elsewhere Hammock" },
      { id: "other-bench-by-the-gate", label: "Elsewhere Bench by the gate" },
    ]);
  });

  test("an empty spots.json means no spots; a bad one names the file, the field and what was found", () => {
    expect(parseSpots([])).toEqual([]);
    expect(() => parseSpots([{ id: "g", name: "G" }])).toThrow(
      /spots\.json: \[0\]: expected exactly one of spots or count/,
    );
    expect(() => parseSpots([{ id: "g", name: "G", count: 0 }])).toThrow(
      /count: expected a whole number from 1 to 500, found number 0/,
    );
    expect(() => parseSpots([{ id: "g", name: "G", spots: ["A", "a"] }])).toThrow(/duplicate/);
  });

  test("an order carries the label of the spot it names, and every audience sees it", () => {
    const o = order([{ itemId: "carrot-cake", qty: 1 }], { spotId: "garden-t4" });
    expect(o.spot).toBe("Garden T4");
    expect(customerView(o).spot).toBe("Garden T4");
    expect(stationView(o, "cakes").spot).toBe("Garden T4");
  });

  test("an unknown spot is refused, naming some that exist", () => {
    expect(() => order([{ itemId: "carrot-cake", qty: 1 }], { spotId: "nowhere" })).toThrow(
      /bad_spot: expected a spot id from spots\.json \(garden-t1/,
    );
  });

  test("a business without spots has none", () => {
    expect(loadSample("tea-house").zones).toEqual([]);
  });
});

describe("extras", () => {
  test("are priced into the unit price when added, and listed in the catalog order", () => {
    const o = order([{ itemId: "latte", size: "Large", qty: 2, extras: ["oat-milk", "extra-shot"] }]);
    const line = o.lines[0];
    expect(line?.extras).toEqual([
      { id: "extra-shot", name: "Extra shot", priceMinor: 50 },
      { id: "oat-milk", name: "Oat milk", priceMinor: 50 },
    ]);
    expect(line?.unitMinor).toBe(480 + 100);
    expect(orderTotal(o)).toBe(2 * 580);
  });

  test("only the groups an item offers, each within its min and max", () => {
    expect(extraGroupsFor(cafe, "latte").map((g) => g.id)).toEqual(["shots", "milk", "drink-extras"]);
    expect(extraGroupsFor(cafe, "burrito").map((g) => g.id)).toEqual(["gluten-free", "wrap-extras"]);
    expect(() => order([{ itemId: "carrot-cake", qty: 1, extras: ["honey"] }])).toThrow(
      /bad_extras: expected only options carrot-cake offers/,
    );
    expect(() => order([{ itemId: "latte", size: "Large", qty: 1, extras: ["soy-milk", "oat-milk"] }])).toThrow(
      /expected 0 to 1 of Milk/,
    );
    expect(() => order([{ itemId: "toast", qty: 1 }])).toThrow(/bad_extras: expected 1 of Bread for toast, found 0/);
    expect(() => order([{ itemId: "flat-white", qty: 1, extras: ["honey", "honey"] }])).toThrow(/each extra once/);
    expect(order([{ itemId: "toast", qty: 1, extras: ["rye"] }]).lines[0]?.unitMinor).toBe(890);
  });

  test("a bad group fails loudly: negative price, min above max, repeated option id, unknown group", () => {
    const bad = (f: (extras: Json, c: Json) => void) => () => parseCatalog(catalogWith((c) => f(c.extras, c)));
    expect(bad((g) => (g[0].options[0].price = -1))).toThrow(ConfigError);
    expect(bad((g) => (g[1].min = 2))).toThrow(/min up to the max \(1\)/);
    expect(bad((g) => (g[1].options[0].id = "honey"))).toThrow(/unique option id/);
    expect(bad((_g, c) => (c.categories[0].extras = ["nope"]))).toThrow(
      /catalog\.json: categories\[0\]\.extras\[0\]: expected a group id from the catalog's extras, found "nope"/,
    );
  });
});

describe("notes", () => {
  test("are trimmed and kept on the line; a blank one is no note", () => {
    const o = order([
      { itemId: "burrito", qty: 1, note: "  less   spicy,\nno onion " },
      { itemId: "masala-eggs", qty: 1, note: "   " },
    ]);
    expect(o.lines[0]?.note).toBe("less spicy, no onion");
    expect(o.lines[1]?.note).toBeUndefined();
  });

  test("are bounded", () => {
    expect(() => order([{ itemId: "burrito", qty: 1, note: "x".repeat(NOTE_MAX + 1) }])).toThrow(OrderError);
    expect(order([{ itemId: "burrito", qty: 1, note: "x".repeat(NOTE_MAX) }]).lines[0]?.note).toHaveLength(NOTE_MAX);
  });
});

describe("routing per item", () => {
  const setStation = (station: string) =>
    catalogWith((c) => {
      c.categories[3].items[0].station = station;
    });

  test("an item station overrides its category's, and an unknown one is refused at load", () => {
    expect(stationFor(cafe, "chia-pudding").id).toBe("smoothies");
    expect(stationFor(cafe, "mango-smoothie").id).toBe("smoothies");
    const raw = sampleRaw("garden-cafe");
    expect(stationFor(loadConfig({ ...raw, catalog: setStation("bar") }), "carrot-cake").id).toBe("bar");
    expect(() => loadConfig({ ...raw, catalog: setStation("nowhere") })).toThrow(
      /catalog\.json: item carrot-cake\.station: expected a station id from stations\.json, found "nowhere"/,
    );
  });

  test("a line lands on its item's station", () => {
    expect(order([{ itemId: "chia-pudding", qty: 1 }]).lines[0]?.stationId).toBe("smoothies");
  });
});

describe("batches", () => {
  test("lines with different extras or notes are separate rows; the spoken text names them", () => {
    const a = order([{ itemId: "latte", size: "Regular", qty: 2, extras: ["oat-milk"] }]);
    const b = createOrder(cafe, {
      id: "o2",
      token: "01-002",
      now: 2_000,
      lines: [
        { itemId: "latte", size: "Regular", qty: 1, extras: ["oat-milk"] },
        { itemId: "latte", size: "Regular", qty: 1 },
        { itemId: "latte", size: "Regular", qty: 1, note: "extra hot" },
      ],
    });
    const batch = openBatch([a, b], "bar");
    expect(batch.lines.map((l) => [l.qty, l.extras, l.note])).toEqual([
      [3, ["Oat milk"], undefined],
      [1, undefined, undefined],
      [1, undefined, "extra hot"],
    ]);
    expect(renderBatch(batch, en)).toBe(
      "Orders #1, #2 3 Latte Regular Oat milk, 1 Latte Regular, 1 Latte Regular (extra hot)",
    );
    const group = groupBatch([a, b], "bar")[0];
    expect(group?.total).toBe(5);
    expect(group?.rows.map((r) => [r.qty, r.tokens])).toEqual([
      [3, ["01-001", "01-002"]],
      [1, ["01-002"]],
      [1, ["01-002"]],
    ]);
  });
});

describe("when a line was ready and handed over", () => {
  test("is stamped when a time is given", () => {
    const o = order([{ itemId: "latte", size: "Regular", qty: 1 }]);
    const ready = markReady(o, "bar", [0], 5_000);
    expect(ready.lines[0]?.readyAt).toBe(5_000);
    expect(markServed(ready, 0, 9_000).lines[0]).toMatchObject({ readyAt: 5_000, servedAt: 9_000 });
  });
});

describe("the 300-order garden rush", () => {
  type RushJson = { orders: { lines: { extras?: string[]; note?: string }[]; spot?: string }[] };
  const rush = readSample("garden-cafe", "rush.json") as RushJson;

  test("carries extras, notes and spots, and every line reaches exactly one station", () => {
    expect(rush.orders).toHaveLength(300);
    const lines = rush.orders.flatMap((r) => r.lines);
    expect(lines.filter((l) => l.extras).length).toBeGreaterThan(30);
    expect(lines.filter((l) => l.note).length).toBeGreaterThan(5);
    expect(rush.orders.filter((r) => r.spot).length).toBeGreaterThan(200);
    const orders = rush.orders.map((r, i) =>
      createOrder(cafe, {
        id: `r${i}`,
        token: `01-${i}`,
        now: 1,
        lines: r.lines as never,
        ...(r.spot ? { spotId: r.spot } : {}),
      }),
    );
    const all = orders.flatMap((o) => o.lines);
    const perStation = cafe.stations.map((s) => openBatch(orders, s.id).lines.reduce((n, l) => n + l.qty, 0));
    expect(perStation.reduce((a, b) => a + b, 0)).toBe(all.reduce((n, l) => n + l.qty, 0));
    expect(perStation.every((n) => n > 0)).toBe(true);
    expect(all.every((l) => cafe.stations.some((s) => s.id === l.stationId))).toBe(true);
  });
});

describe("diet and allergen filters", () => {
  test("come from the catalog and keep or drop items by tag", async () => {
    const { visibleCategories } = await import("../src/client/catalog.ts");
    const filters = cafe.catalog.filters ?? [];
    expect(filters.map((f) => f.id)).toEqual(["vegan", "gluten-free", "no-nuts"]);
    const ids = (on: string[]) =>
      visibleCategories(
        cafe.catalog.categories,
        "",
        undefined,
        filters.filter((f) => on.includes(f.id)),
      ).flatMap((c) => c.items.map((i) => i.id));
    expect(ids(["vegan"])).toEqual(["mango-smoothie", "chia-pudding", "toast"]);
    expect(ids(["vegan", "gluten-free"])).toEqual(["mango-smoothie", "chia-pudding"]);
    expect(ids(["no-nuts"])).not.toContain("carrot-cake");
    expect(ids(["no-nuts"])).toContain("lemon-tart");
  });

  test("a filter with a bad mode fails loudly", () => {
    const bad = catalogWith((c) => {
      c.filters[0].mode = "maybe";
    });
    expect(() => parseCatalog(bad)).toThrow(/filters\[0\]\.mode: expected "include" or "exclude", found "maybe"/);
  });
});
