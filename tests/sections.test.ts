import { describe, expect, test } from "vitest";
import { createOrder } from "../src/core/orders.ts";
import {
  editableSections,
  parseSections,
  SectionError,
  sectionOf,
  tableZones,
  withLayout,
} from "../src/core/sections.ts";
import { loadSample } from "./support/samples.ts";

const cafe = loadSample("garden-cafe");
const rooms = cafe.zones.filter((z) => z.kind === "room");

function refused(raw: unknown): SectionError {
  try {
    parseSections(raw, rooms);
  } catch (e) {
    if (e instanceof SectionError) return e;
    throw e;
  }
  throw new Error("expected a SectionError, found none");
}

describe("parseSections (D-102)", () => {
  test("a section's spots get the ids and labels spots.json would give them", () => {
    const [z] = parseSections([{ id: "patio", name: "Patio", spots: ["P1", "Big table"] }], rooms);
    expect(z).toEqual({
      id: "patio",
      name: "Patio",
      spots: [
        { id: "patio-p1", label: "Patio P1" },
        { id: "patio-big-table", label: "Patio Big table" },
      ],
    });
  });

  test("a new section without an id gets one from its name, kept apart from every other", () => {
    const zones = parseSections(
      [
        { name: "Roof Deck", spots: ["1"] },
        { name: "roof deck!", spots: [] },
      ],
      rooms,
    );
    expect(zones.map((z) => z.id)).toEqual(["roof-deck", "roof-deck-2"]);
    expect(zones[1]?.spots).toEqual([]);
  });

  test("ids, names and spots are checked with the spots.json rules, naming the field", () => {
    expect(refused([{ id: "Patio", name: "Patio", spots: [] }]).message).toMatch(/\[0\]\.id.*lowercase/);
    expect(refused([{ id: "p", name: " ", spots: [] }]).message).toMatch(/\[0\]\.name/);
    expect(refused([{ id: "p", name: "P", spots: ["1", "1"] }]).message).toMatch(/\[0\]\.spots\[1\].*unique/);
    expect(refused([{ id: "p", name: "P", spots: ["!!"] }]).message).toMatch(/letter or digit/);
    expect(
      refused([
        { id: "p", name: "P", spots: [] },
        { id: "p", name: "Q", spots: [] },
      ]).message,
    ).toMatch(/zone id/);
    expect(refused({}).code).toBe("bad_sections");
  });

  test("room sections are refused: their QR keys depend on spots.json", () => {
    expect(refused([{ id: "rooms", name: "Room", spots: ["1"] }]).code).toBe("room_section");
    expect(refused([{ id: "suites", name: "Suite", kind: "room", spots: ["1"] }]).code).toBe("room_section");
    // A table whose spot would read like a room's ("Room 1") is refused too, so staff never confuse the two.
    expect(refused([{ id: "lobby", name: "Room", spots: ["1"] }]).code).toBe("bad_sections");
  });

  test("a renamed spot keeps its id, so its printed QR card still picks it; only a new spot gets a new id", () => {
    const zones = parseSections(
      [
        {
          id: "patio",
          name: "Patio",
          spots: [{ id: "patio-p1", name: "Window" }, "P1", { id: "patio-p2", name: "P2" }],
        },
      ],
      rooms,
    );
    expect(zones[0]?.spots).toEqual([
      { id: "patio-p1", label: "Patio Window" },
      // "P1" would take patio-p1, which the renamed spot keeps: the new spot gets the next free id.
      { id: "patio-p1-2", label: "Patio P1" },
      { id: "patio-p2", label: "Patio P2" },
    ]);
    expect(refused([{ id: "p", name: "P", spots: [{ id: "Bad id", name: "1" }] }]).message).toMatch(/lowercase/);
    expect(refused([{ id: "p", name: "P", spots: [{ id: "rooms-1", name: "Quiet" }] }]).message).toMatch(/room/);
    expect(
      refused([
        { id: "p", name: "P", spots: [{ id: "p-1", name: "1" }] },
        { id: "q", name: "Q", spots: [{ id: "p-1", name: "2" }] },
      ]).message,
    ).toMatch(/unique/);
  });

  test("the count of sections and spots is bounded", () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ name: `S${i}`, spots: [] }));
    expect(refused(many).message).toMatch(/at most 50/);
  });
});

describe("the layout in force", () => {
  test("without an edit the config's zones stand; with one, the edited tables replace the config's and rooms stay", () => {
    expect(withLayout(cafe, undefined)).toBe(cafe);
    const edited = parseSections([{ id: "patio", name: "Patio", spots: ["P1"] }], rooms);
    const live = withLayout(cafe, edited);
    expect(live.zones.map((z) => z.id)).toEqual(["patio", "rooms"]);
    expect(live.spots.get("patio-p1")?.label).toBe("Patio P1");
    expect(live.spots.has("garden-t1")).toBe(false);
    expect(live.spots.has("rooms-1")).toBe(true);
    expect(tableZones(live).map((z) => z.id)).toEqual(["patio"]);
  });

  test("an order takes a spot of the edited layout and keeps its id and label", () => {
    const live = withLayout(cafe, parseSections([{ id: "patio", name: "Patio", spots: ["P1"] }], rooms));
    const o = createOrder(live, {
      id: "o",
      token: "01-001",
      now: 1,
      spotId: "patio-p1",
      lines: [{ itemId: "carrot-cake", qty: 1 }],
    });
    expect(o).toMatchObject({ spot: "Patio P1", spotId: "patio-p1" });
    expect(() =>
      createOrder(live, {
        id: "o",
        token: "01-001",
        now: 1,
        spotId: "garden-t1",
        lines: [{ itemId: "carrot-cake", qty: 1 }],
      }),
    ).toThrow(/bad_spot/);
  });

  test("the editable form gives each table section back as its own spot names", () => {
    expect(editableSections(cafe)[0]).toEqual({
      id: "garden",
      name: "Garden",
      spots: Array.from({ length: 14 }, (_, i) => ({ id: `garden-t${i + 1}`, name: `T${i + 1}` })),
    });
    expect(editableSections(cafe).some((s) => s.id === "rooms")).toBe(false);
    // Round trip: the editable form parses back to the same zones.
    expect(parseSections(editableSections(cafe), rooms)).toEqual(tableZones(cafe));
  });
});

describe("sectionOf", () => {
  test("by the order's spot id, else by its label (orders taken before spot ids were kept), else none", () => {
    expect(sectionOf({ spotId: "garden-t4", spot: "Garden T4" }, cafe.zones)).toBe("garden");
    expect(sectionOf({ spot: "Terrace 2" }, cafe.zones)).toBe("terrace");
    expect(sectionOf({ spotId: "gone-1", spot: "Gone 1" }, cafe.zones)).toBeUndefined();
    expect(sectionOf({}, cafe.zones)).toBeUndefined();
  });
});
