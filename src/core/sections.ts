/**
 * Sections the owner edits (D-102): the table zones of `spots.json`, replaced at run time by a layout the owner or a
 * manager keeps in the store. Room zones stay in `spots.json` only, since each room's QR key is made from its spot id
 * (D-082). Pure: validation, the layout in force, and which section an order sits in.
 */

import { type Config, ConfigError, parseSpots, type Spot, type Zone } from "./config.ts";

/**
 * A spot as the editor sends it: its own name ("T4", "Hammock") with the id it already has, which a rename keeps; a new
 * spot comes without an id (or as its bare name) and gets one from its name.
 */
export type SpotInput = string | { id?: string; name: string };

/** A section as the editor sends it and the store keeps it. */
export interface SectionInput {
  /** Absent for a new section: one is made from its name. */
  id?: string;
  name: string;
  spots: SpotInput[];
}

export const MAX_SECTIONS = 50;
export const MAX_SECTION_SPOTS = 500;
export const MAX_SECTION_NAME = 40;

export type SectionErrorCode = "bad_sections" | "room_section";

export class SectionError extends Error {
  readonly code: SectionErrorCode;
  constructor(code: SectionErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "SectionError";
    this.code = code;
  }
}

const FILE = "sections";

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * The table sections an edit asks for, checked with the rules `spots.json` follows (ids, names, unique spot ids and
 * labels), and against the room zones, which can't be edited here and whose spots no table may shadow. Throws
 * `SectionError`, naming the field.
 */
export function parseSections(raw: unknown, rooms: readonly Zone[]): Zone[] {
  if (!Array.isArray(raw))
    throw new SectionError("bad_sections", "expected an array of sections, found something else");
  if (raw.length > MAX_SECTIONS) {
    throw new SectionError("bad_sections", `expected at most ${MAX_SECTIONS} sections, found ${raw.length}`);
  }
  const roomIds = new Set(rooms.map((z) => z.id));
  const taken = new Set<string>(roomIds);
  // Spot ids already given (kept through a rename) and the rooms', which a new spot's id must stay apart from.
  const takenSpots = new Set<string>(rooms.flatMap((z) => z.spots.map((s) => s.id)));
  for (const s of raw) {
    const id = (s as { id?: unknown } | null)?.id;
    if (typeof id === "string") taken.add(id);
    const spots = (s as { spots?: unknown } | null)?.spots;
    if (!Array.isArray(spots)) continue;
    for (const spot of spots) {
      const kept = (spot as { id?: unknown } | null)?.id;
      if (typeof kept === "string") takenSpots.add(kept);
    }
  }
  /** A new spot's id from its name, apart from every kept one; a name the rules refuse is left for them to name. */
  const spotsOf = (sectionId: unknown, spots: unknown): unknown => {
    if (typeof sectionId !== "string" || !Array.isArray(spots)) return spots;
    return spots.map((spot) => {
      const name = typeof spot === "string" ? spot : (spot as { name?: unknown } | null)?.name;
      const kept = (spot as { id?: unknown } | null)?.id;
      if (typeof spot === "object" && spot !== null && kept !== undefined) return spot;
      if (typeof name !== "string" || slug(name) === "") return typeof spot === "string" ? spot : name;
      const base = `${sectionId}-${slug(name)}`;
      let id = base;
      for (let n = 2; takenSpots.has(id); n++) id = `${base}-${n}`;
      takenSpots.add(id);
      return { id, name };
    });
  };
  const prepared = raw.map((s, i) => {
    if (typeof s !== "object" || s === null || Array.isArray(s)) {
      throw new SectionError("bad_sections", `[${i}]: expected an object, found something else`);
    }
    const o = s as Record<string, unknown>;
    if (o.kind === "room" || (typeof o.id === "string" && roomIds.has(o.id))) {
      throw new SectionError(
        "room_section",
        `[${i}]: expected a table section, found a room section; rooms are set in spots.json, since each room's QR key depends on it`,
      );
    }
    if (typeof o.name === "string" && o.name.trim().length > MAX_SECTION_NAME) {
      throw new SectionError("bad_sections", `[${i}].name: expected at most ${MAX_SECTION_NAME} characters`);
    }
    if (Array.isArray(o.spots) && o.spots.length > MAX_SECTION_SPOTS) {
      throw new SectionError("bad_sections", `[${i}].spots: expected at most ${MAX_SECTION_SPOTS} spots`);
    }
    if (o.id !== undefined) return { id: o.id, name: o.name, spots: spotsOf(o.id, o.spots) };
    // A new section: an id from its name, apart from every other section's.
    const base = typeof o.name === "string" ? slug(o.name) : "";
    if (base === "") return { id: o.id, name: o.name, spots: o.spots };
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    taken.add(id);
    return { id, name: o.name, spots: spotsOf(id, o.spots) };
  });
  let zones: Zone[];
  try {
    zones = parseSpots(prepared, FILE, { emptyZones: true, keepIds: true });
  } catch (e) {
    if (e instanceof ConfigError) throw new SectionError("bad_sections", e.message);
    throw e;
  }
  const roomSpots = new Set(rooms.flatMap((z) => z.spots.flatMap((s) => [s.id, s.label])));
  for (const [i, z] of zones.entries()) {
    for (const [j, s] of z.spots.entries()) {
      if (roomSpots.has(s.id) || roomSpots.has(s.label)) {
        throw new SectionError(
          "bad_sections",
          `[${i}].spots[${j}]: expected a spot apart from the rooms, found ${JSON.stringify(s.label)} already a room's`,
        );
      }
    }
  }
  return zones;
}

/** The config's zones that are tables (not rooms). */
export function tableZones(config: Pick<Config, "zones">): Zone[] {
  return config.zones.filter((z) => z.kind !== "room");
}

/** The config with an edited layout in force: the edited tables first, then the rooms of `spots.json`. Unchanged without an edit. */
export function withLayout(config: Config, tables: readonly Zone[] | undefined): Config {
  if (tables === undefined) return config;
  const zones = [...tables, ...config.zones.filter((z) => z.kind === "room")];
  const spots = new Map<string, Spot>();
  for (const z of zones) for (const s of z.spots) spots.set(s.id, s);
  return { ...config, zones, spots };
}

/** A saved section as the editor receives it: every spot with its id. */
export interface EditableSection {
  id: string;
  name: string;
  spots: { id: string; name: string }[];
}

/** The table sections in the form the editor shows and sends back: each spot by its own name, with its id. */
export function editableSections(config: Pick<Config, "zones">): EditableSection[] {
  return tableZones(config).map((z) => ({
    id: z.id,
    name: z.name,
    spots: z.spots.map((s) => ({ id: s.id, name: s.label.slice(z.name.length + 1) })),
  }));
}

/**
 * The section an order sits in: its spot id's zone, or for an order taken before spot ids were kept, the zone whose spot
 * has its label. Undefined when it has no spot or its spot was deleted since.
 */
export function sectionOf(order: { spotId?: string; spot?: string }, zones: readonly Zone[]): string | undefined {
  for (const z of zones) {
    if (z.spots.some((s) => (order.spotId === undefined ? s.label === order.spot : s.id === order.spotId))) return z.id;
  }
  return undefined;
}
