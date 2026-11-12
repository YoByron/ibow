import { describe, expect, test } from "vitest";
import { ConfigError, loadConfig, parseBusiness, parseCatalog, parseStations, stationFor } from "../src/core/config.ts";
import { loadSample } from "./support/samples.ts";

const catalog = {
  categories: [
    { id: "hot", name: "Hot", items: [{ id: "chai", name: "Chai", variants: [{ size: "S", price: 2000 }] }] },
    { id: "food", name: "Food", items: [{ id: "momos", name: "Momos", price: 8000, available: false }] },
  ],
};
const business = { name: "Business", currency: "USD", timeZone: "America/New_York" };
const stations = [
  { id: "tea", name: "Tea", categories: ["hot"], speak: true, print: null },
  { id: "kitchen", name: "Kitchen", categories: ["food"], speak: true, print: "ticket-80mm" },
];

function errorOf(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e;
    throw e;
  }
  throw new Error("expected a ConfigError");
}

describe("config", () => {
  test("loads a valid config", () => {
    const config = loadConfig({ business, catalog, stations });
    expect(config.business).toEqual({
      name: "Business",
      currency: "USD",
      timeZone: "America/New_York",
      maxQtyPerLine: 99,
      retentionDays: 30,
    });
    expect(stationFor(config, "chai").id).toBe("tea");
    expect(stationFor(config, "momos").id).toBe("kitchen");
  });

  test("errors name the file, the field, what was expected and what was found", () => {
    const bad = structuredClone(catalog);
    (bad.categories[1]?.items[0] as { price: unknown }).price = 80.5;
    const e = errorOf(() => parseCatalog(bad));
    expect(e.file).toBe("catalog.json");
    expect(e.field).toBe("categories[1].items[0].price");
    expect(e.message).toBe(
      "catalog.json: categories[1].items[0].price: expected a price in integer minor units (such as cents) greater than 0, found number 80.5",
    );
  });

  test("an item needs exactly one of price or variants", () => {
    const both = { categories: [{ id: "a", name: "A", items: [{ id: "x", name: "X", price: 100, variants: [] }] }] };
    expect(errorOf(() => parseCatalog(both)).message).toContain(
      "expected exactly one of price or variants, found both",
    );
  });

  test("rejects duplicate item ids and variant sizes", () => {
    const dup = structuredClone(catalog) as { categories: { items: unknown[] }[] };
    dup.categories[1]?.items.push({ id: "chai", name: "Again", price: 100 });
    expect(errorOf(() => parseCatalog(dup)).field).toBe("categories[1].items[1].id");
    const sizes = { categories: [{ id: "a", name: "A", items: [{ id: "x", name: "X", variants: [] as unknown[] }] }] };
    sizes.categories[0]?.items[0]?.variants.push({ size: "S", price: 1 }, { size: "S", price: 2 });
    expect(errorOf(() => parseCatalog(sizes)).field).toBe("categories[0].items[0].variants[1].size");
  });

  test("refuses a field it does not know, naming it, so a typo cannot silently do nothing", () => {
    const err = errorOf(() => parseBusiness({ ...business, showCase: true }));
    expect(err.field).toBe("showCase");
    expect(err.message).toBe(
      "business.json: showCase: expected one of name, currency, timeZone, maxQtyPerLine, retentionDays, cashShortcuts, hours, showcase, phone, address, found an unknown field",
    );
    expect(parseBusiness({ ...business, showcase: true }).showcase).toBe(true);
  });

  test("needs a known time zone, with no default", () => {
    expect(errorOf(() => parseBusiness({ ...business, timeZone: "Mars/Olympus" })).field).toBe("timeZone");
    const { timeZone: _, ...noZone } = business;
    expect(errorOf(() => parseBusiness(noZone)).message).toBe(
      "business.json: timeZone: expected an IANA time zone such as Asia/Dubai, found nothing",
    );
  });

  test("takes an optional maxQtyPerLine, a whole number from 1 to 10000", () => {
    expect(parseBusiness({ ...business, maxQtyPerLine: 5 }).maxQtyPerLine).toBe(5);
    expect(errorOf(() => parseBusiness({ ...business, maxQtyPerLine: 0 })).field).toBe("maxQtyPerLine");
    expect(errorOf(() => parseBusiness({ ...business, maxQtyPerLine: 2.5 })).field).toBe("maxQtyPerLine");
    expect(errorOf(() => parseBusiness({ ...business, maxQtyPerLine: 10_001 })).field).toBe("maxQtyPerLine");
  });

  test("needs an ISO 4217 currency, with no default", () => {
    const { currency: _, ...noCurrency } = business;
    expect(errorOf(() => parseBusiness(noCurrency)).message).toBe(
      "business.json: currency: expected an ISO 4217 currency code such as USD, found nothing",
    );
    expect(errorOf(() => parseBusiness({ ...business, currency: "usd" })).field).toBe("currency");
    expect(errorOf(() => parseBusiness({ ...business, currency: "XYZ" })).field).toBe("currency");
  });

  test("takes optional cash shortcuts in major units and keeps them in minor units", () => {
    expect(parseBusiness(business).cashShortcutsMinor).toBeUndefined();
    expect(parseBusiness({ ...business, cashShortcuts: [5, 10, 20, 0.25] }).cashShortcutsMinor).toEqual([
      500, 1000, 2000, 25,
    ]);
    const yen = { ...business, currency: "JPY" };
    expect(parseBusiness({ ...yen, cashShortcuts: [500, 1000] }).cashShortcutsMinor).toEqual([500, 1000]);
    expect(errorOf(() => parseBusiness({ ...yen, cashShortcuts: [0.5] })).message).toBe(
      "business.json: cashShortcuts[0]: expected an amount above 0 in major units of JPY with at most 0 decimals, found number 0.5",
    );
    expect(errorOf(() => parseBusiness({ ...business, cashShortcuts: [5, -1] })).field).toBe("cashShortcuts[1]");
    expect(errorOf(() => parseBusiness({ ...business, cashShortcuts: [] })).field).toBe("cashShortcuts");
    expect(errorOf(() => parseBusiness({ ...business, cashShortcuts: "5" })).field).toBe("cashShortcuts");
  });

  test("a station shows a batch unless its view says jobs", () => {
    const parsed = parseCatalog(catalog);
    expect(parseStations(stations, parsed).map((s) => s.view)).toEqual(["batch", "batch"]);
    const jobs = [stations[0], { ...stations[1], view: "jobs" }];
    expect(parseStations(jobs, parsed).map((s) => s.view)).toEqual(["batch", "jobs"]);
    const bad = [stations[0], { ...stations[1], view: "tickets" }];
    expect(errorOf(() => parseStations(bad, parsed)).message).toBe(
      'stations.json: [1].view: expected "batch" or "jobs", found "tickets"',
    );
  });

  test("every category maps to exactly one station", () => {
    const parsed = parseCatalog(catalog);
    const missing = [stations[0]];
    expect(errorOf(() => parseStations(missing, parsed)).message).toContain('no station for "food"');
    const twice = [stations[0], { ...stations[1], categories: ["food", "hot"] }];
    expect(errorOf(() => parseStations(twice, parsed)).field).toBe("[1].categories[1]");
    const unknown = [{ ...stations[0], categories: ["hot", "cold"] }, stations[1]];
    expect(errorOf(() => parseStations(unknown, parsed)).message).toContain(
      'expected a category id from the catalog, found "cold"',
    );
  });

  test("stationFor fails loudly on an unknown item", () => {
    const config = loadConfig({ business, catalog, stations });
    expect(() => stationFor(config, "nope")).toThrow('found "nope"');
  });
});

describe("tea-house sample", () => {
  test("is valid config with prices in minor units", () => {
    const config = loadSample("tea-house");
    expect(config.items.size).toBe(78);
    expect(config.items.get("house-special-chai")?.item.variants).toEqual([
      { size: "S", price: 2000 },
      { size: "M", price: 3000 },
      { size: "L", price: 4000 },
    ]);
  });

  test("routes tea/coffee to the tea station and everything else to the kitchen", () => {
    const config = loadSample("tea-house");
    const teaCategory = config.catalog.categories.find((c) => c.name === "Tea / Coffee");
    expect(teaCategory).toBeDefined();
    for (const category of config.catalog.categories) {
      const expected = category === teaCategory ? "tea" : "kitchen";
      for (const item of category.items) expect(stationFor(config, item.id).id, item.id).toBe(expected);
    }
  });
});

describe("catalog presentation fields (M8)", () => {
  const withItem = (extra: object) => ({
    categories: [
      { id: "hot", name: "Hot", icon: "hot_beverage", items: [{ id: "chai", name: "Chai", price: 2000, ...extra }] },
    ],
  });

  test("an item may carry a description, a photo and a diet; a category an icon", () => {
    const c = parseCatalog(withItem({ description: "Slow-brewed", image: "chai.jpg", diet: "veg" }));
    expect(c.categories[0]).toMatchObject({ icon: "hot_beverage" });
    expect(c.categories[0]?.items[0]).toMatchObject({ description: "Slow-brewed", image: "chai.jpg", diet: "veg" });
  });

  test("bad ones name the path and the field", () => {
    expect(errorOf(() => parseCatalog(withItem({ icon: "nope" }))).field).toBe("categories[0].items[0].icon");
    expect(parseCatalog(withItem({ icon: "fire" })).categories[0]?.items[0]?.icon).toBe("fire");
    expect(errorOf(() => parseCatalog(withItem({ diet: "meat" }))).field).toBe("categories[0].items[0].diet");
    expect(errorOf(() => parseCatalog(withItem({ image: "../x.png" }))).field).toBe("categories[0].items[0].image");
    expect(errorOf(() => parseCatalog(withItem({ image: "http://x.test/a.png" }))).field).toBe(
      "categories[0].items[0].image",
    );
    expect(errorOf(() => parseCatalog(withItem({ description: "" }))).field).toBe("categories[0].items[0].description");
    const bad = { categories: [{ id: "hot", name: "Hot", icon: "nope", items: [] }] };
    expect(errorOf(() => parseCatalog(bad)).field).toBe("categories[0].icon");
  });
});
