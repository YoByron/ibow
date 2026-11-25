/** Business, catalog and station config: validation and routing. Knows no business, item or category by name. */

import { type Hours, parseHours } from "./hours.ts";
import { isCurrency, minorExponent } from "./money.ts";
import { ICONS, parseImageRef } from "./theme.ts";

export interface Business {
  name: string;
  /** ISO 4217 code; every price and payment is in its minor unit. */
  currency: string;
  /** IANA time zone; the only source of the business's "day". */
  timeZone: string;
  /** Most units one order line may ask for; `business.json` may set it, default 99. */
  maxQtyPerLine: number;
  /** Days a customer's name and review text are kept before the store clears them; `business.json` may set it, default 30. */
  retentionDays: number;
  /** Minutes after which an order handed over in part, or a line left ready, counts as late for the runner; default 6. */
  lateMinutes: number;
  /**
   * Cash amounts the counter offers as one-tap "received" buttons, from `cashShortcuts` in `business.json` (major
   * units, such as `[5, 10, 20, 50]`), kept here in minor units. Absent: the counter derives them from the amount due.
   */
  cashShortcutsMinor?: number[];
  /** `showcase: true` in `business.json` serves the ibow showcase page at `/showcase` on a real install (D-055); a demo always does. */
  showcase?: boolean;
  /** `card: true` in `business.json`: staff may record card payments (D-071). Default off, so a counter without a terminal shows no card button. */
  card?: boolean;
  /**
   * `managerRefundLimit` in `business.json` (major units): the most a manager may refund on one order, in minor units. Absent:
   * managers may not refund; the owner always may (D-072).
   */
  managerRefundLimitMinor?: number;
  phone?: string;
  address?: string;
  /** Opening hours, business-local (`hours: {open: "07:00", close: "22:00"}`); the storefront says "Open now" only with them. */
  hours?: Hours;
}

export type Diet = "veg" | "non-veg" | "egg";
const DIETS: readonly Diet[] = ["veg", "non-veg", "egg"];

export interface Variant {
  size: string;
  /** Integer minor units of the business currency. */
  price: number;
}

export interface CatalogItem {
  id: string;
  name: string;
  /** Integer minor units; present exactly when `variants` is absent. */
  price?: number;
  variants?: Variant[];
  tags?: string[];
  /** A sentence under the name; shown only when present. */
  description?: string;
  /** A bundled icon name for the item's tile; without one the tile shows its category's icon. */
  icon?: string;
  /** A photo: a file in the config folder or an https URL; without one the storefront draws a tile. */
  image?: string;
  /** Shown as a marker on the card when the theme's veg toggle is on. */
  diet?: Diet;
  /** Defaults to true; an unavailable item cannot be ordered. */
  available?: boolean;
  /** Ids of option groups from the catalog's `extras` library, offered on this item besides its category's. */
  extras?: string[];
  /** The station that prepares this item, overriding its category's (a cake in a drinks category). */
  station?: string;
}

/** One choice inside an extras group. Its id is unique across the whole library, so an order names options by id alone. */
export interface ExtraOption {
  id: string;
  name: string;
  /** Integer minor units added to the unit price; 0 for a free choice. */
  price: number;
}

/** A set of options a customer may add to an item ("Milk", "Add-ons"), picked between `min` and `max` times. */
export interface ExtraGroup {
  id: string;
  name: string;
  min: number;
  max: number;
  options: ExtraOption[];
}

export interface Category {
  id: string;
  name: string;
  /** A bundled icon name (`ICONS` in theme.ts) shown on the category's chip and heading. */
  icon?: string;
  /** Option group ids offered on every item of the category. */
  extras?: string[];
  items: CatalogItem[];
}

/**
 * A filter chip on the storefront, from item tags: `include` keeps items carrying `tag` ("vegan"), `exclude` drops items
 * carrying it ("contains-nuts"). It follows the menu's tags only, so an item nobody tagged passes an `exclude` filter.
 */
export interface MenuFilter {
  id: string;
  name: string;
  tag: string;
  mode: "include" | "exclude";
}

export interface Catalog {
  categories: Category[];
  filters?: MenuFilter[];
  /** The library of extras groups that items and categories name by id; absent when the business sells none. */
  extras?: ExtraGroup[];
}

/** A table, bench or corner where customers sit. `label` is what staff see and hear: the zone's name and the spot's. */
export interface Spot {
  id: string;
  label: string;
}

export interface Zone {
  id: string;
  name: string;
  /** `room`: the spots are rooms a business lets, whose guests may put an order on the room bill (D-082). */
  kind?: "room";
  spots: Spot[];
}

/** `batch`: open lines totalled across orders, spoken as one batch. `jobs`: one card per order, for work that belongs to one customer (a repair). */
export type StationView = "batch" | "jobs";

export interface Station {
  id: string;
  name: string;
  categories: string[];
  view: StationView;
  speak: boolean;
  print: "ticket-80mm" | null;
}

export interface Config {
  business: Business;
  catalog: Catalog;
  stations: Station[];
  /** Item id to its item and category id. */
  items: ReadonlyMap<string, { item: CatalogItem; categoryId: string }>;
  /** Category id to the one station that prepares it. */
  stationByCategory: ReadonlyMap<string, Station>;
  /** Where customers may say they sit (`spots.json`); empty when the business has none. */
  zones: Zone[];
  /** Spot id to the spot. */
  spots: ReadonlyMap<string, Spot>;
  /** Extras group id to the group. */
  extraGroups: ReadonlyMap<string, ExtraGroup>;
}

export interface RawConfig {
  business: unknown;
  catalog: unknown;
  stations: unknown;
  /** `spots.json`; optional. */
  spots?: unknown;
}

/** A config file is wrong: names the file, the field path, what was expected and what was found. */
export class ConfigError extends Error {
  readonly file: string;
  readonly field: string;
  constructor(file: string, field: string, expected: string, found: string) {
    super(`${file}: ${field || "(root)"}: expected ${expected}, found ${found}`);
    this.name = "ConfigError";
    this.file = file;
    this.field = field;
  }
}

const ID = /^[a-z0-9][a-z0-9-]*$/;
export const DEFAULT_MAX_QTY = 99;
export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_LATE_MINUTES = 6;

function describe(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return `${typeof value} ${String(value)}`;
  return `a ${typeof value}`;
}

class Reader {
  readonly file: string;
  constructor(file: string) {
    this.file = file;
  }

  fail(field: string, expected: string, found: unknown): never {
    throw new ConfigError(this.file, field, expected, describe(found));
  }

  /** Fails with a found-text that is already a description, not a value. */
  failText(field: string, expected: string, foundText: string): never {
    throw new ConfigError(this.file, field, expected, foundText);
  }

  object(value: unknown, field: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) this.fail(field, "an object", value);
    return value as Record<string, unknown>;
  }

  array(value: unknown, field: string, nonEmpty = false): unknown[] {
    if (!Array.isArray(value)) this.fail(field, "an array", value);
    if (nonEmpty && value.length === 0) this.failText(field, "a non-empty array", "an empty array");
    return value;
  }

  string(value: unknown, field: string): string {
    if (typeof value !== "string" || value.trim() === "") this.fail(field, "a non-empty string", value);
    return value;
  }

  id(value: unknown, field: string): string {
    const s = this.string(value, field);
    if (!ID.test(s)) this.fail(field, "an id of lowercase letters, digits and dashes", s);
    return s;
  }

  minor(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      this.fail(field, "a price in integer minor units (such as cents) greater than 0", value);
    }
    return value;
  }

  /** Like `minor` but 0 is allowed: a free option. */
  minorOrZero(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      this.fail(field, "a price in integer minor units (such as cents), 0 or more", value);
    }
    return value;
  }

  boolean(value: unknown, field: string): boolean {
    if (typeof value !== "boolean") this.fail(field, "true or false", value);
    return value;
  }

  unique(seen: Set<string>, value: string, field: string, what: string): void {
    if (seen.has(value)) this.failText(field, `a unique ${what}`, `a duplicate ${JSON.stringify(value)}`);
    seen.add(value);
  }
}

/** Every field `business.json` may hold; any other is refused, so a typo fails loudly. */
const BUSINESS_FIELDS = [
  "name",
  "currency",
  "timeZone",
  "maxQtyPerLine",
  "retentionDays",
  "lateMinutes",
  "cashShortcuts",
  "hours",
  "showcase",
  "card",
  "managerRefundLimit",
  "phone",
  "address",
];

export function parseBusiness(raw: unknown, file = "business.json"): Business {
  const r = new Reader(file);
  const o = r.object(raw, "");
  for (const k of Object.keys(o)) {
    if (!BUSINESS_FIELDS.includes(k)) r.failText(k, `one of ${BUSINESS_FIELDS.join(", ")}`, "an unknown field");
  }
  const name = r.string(o.name, "name");
  const currency = o.currency;
  if (typeof currency !== "string" || !isCurrency(currency)) {
    return r.fail("currency", "an ISO 4217 currency code such as USD", currency);
  }
  const timeZone = o.timeZone;
  const zoneExpected = "an IANA time zone such as Asia/Dubai";
  if (typeof timeZone !== "string" || timeZone.trim() === "") return r.fail("timeZone", zoneExpected, timeZone);
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    r.fail("timeZone", zoneExpected, timeZone);
  }
  let maxQtyPerLine = DEFAULT_MAX_QTY;
  if (o.maxQtyPerLine !== undefined) {
    const m = o.maxQtyPerLine;
    if (typeof m !== "number" || !Number.isInteger(m) || m < 1 || m > 10_000) {
      return r.fail("maxQtyPerLine", "a whole number from 1 to 10000", m);
    }
    maxQtyPerLine = m;
  }
  let retentionDays = DEFAULT_RETENTION_DAYS;
  if (o.retentionDays !== undefined) {
    const d = o.retentionDays;
    if (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > 3650) {
      return r.fail("retentionDays", "a whole number of days from 1 to 3650", d);
    }
    retentionDays = d;
  }
  let lateMinutes = DEFAULT_LATE_MINUTES;
  if (o.lateMinutes !== undefined) {
    const m = o.lateMinutes;
    if (typeof m !== "number" || !Number.isInteger(m) || m < 1 || m > 120) {
      return r.fail("lateMinutes", "a whole number of minutes from 1 to 120", m);
    }
    lateMinutes = m;
  }
  const business: Business = { name, currency, timeZone, maxQtyPerLine, retentionDays, lateMinutes };
  if (o.cashShortcuts !== undefined) {
    const exp = minorExponent(currency);
    const expected = `an amount above 0 in major units of ${currency} with at most ${exp} decimals`;
    business.cashShortcutsMinor = r.array(o.cashShortcuts, "cashShortcuts", true).map((v, i) => {
      const minor = typeof v === "number" ? Math.round(v * 10 ** exp) : Number.NaN;
      // The round trip catches extra decimals (0.5 yen) without trusting float equality on the scaled value.
      if (typeof v !== "number" || !Number.isSafeInteger(minor) || minor <= 0 || minor / 10 ** exp !== v) {
        return r.fail(`cashShortcuts[${i}]`, expected, v);
      }
      return minor;
    });
  }
  if (o.hours !== undefined) {
    const h = r.object(o.hours, "hours");
    const hours = parseHours(h.open, h.close, h.lastOrder, h.closedDays);
    if (hours === undefined) {
      return r.fail(
        "hours",
        '{open, close, lastOrder?, closedDays?}: HH:MM, 24 hour, lastOrder inside the open hours, closedDays some of "mon" to "sun"',
        o.hours,
      );
    }
    business.hours = hours;
  }
  if (o.showcase !== undefined) business.showcase = r.boolean(o.showcase, "showcase");
  if (o.card !== undefined) business.card = r.boolean(o.card, "card");
  if (o.managerRefundLimit !== undefined) {
    const exp = minorExponent(currency);
    const v = o.managerRefundLimit;
    const minor = typeof v === "number" ? Math.round(v * 10 ** exp) : Number.NaN;
    if (typeof v !== "number" || !Number.isSafeInteger(minor) || minor <= 0 || minor / 10 ** exp !== v) {
      return r.fail(
        "managerRefundLimit",
        `an amount above 0 in major units of ${currency} with at most ${exp} decimals`,
        v,
      );
    }
    business.managerRefundLimitMinor = minor;
  }
  if (o.phone !== undefined) business.phone = r.string(o.phone, "phone");
  if (o.address !== undefined) business.address = r.string(o.address, "address");
  return business;
}

function parseItem(r: Reader, raw: unknown, field: string): CatalogItem {
  const o = r.object(raw, field);
  const item: CatalogItem = { id: r.id(o.id, `${field}.id`), name: r.string(o.name, `${field}.name`) };
  const hasPrice = o.price !== undefined;
  const hasVariants = o.variants !== undefined;
  if (hasPrice === hasVariants) {
    r.failText(field, "exactly one of price or variants", hasPrice ? "both" : "neither");
  }
  if (hasPrice) item.price = r.minor(o.price, `${field}.price`);
  if (hasVariants) {
    const sizes = new Set<string>();
    item.variants = r.array(o.variants, `${field}.variants`, true).map((v, i) => {
      const vf = `${field}.variants[${i}]`;
      const vo = r.object(v, vf);
      const size = r.string(vo.size, `${vf}.size`);
      r.unique(sizes, size, `${vf}.size`, "size within the item");
      return { size, price: r.minor(vo.price, `${vf}.price`) };
    });
  }
  if (o.tags !== undefined) {
    item.tags = r.array(o.tags, `${field}.tags`).map((t, i) => r.string(t, `${field}.tags[${i}]`));
  }
  if (o.icon !== undefined) {
    const icon = o.icon;
    if (typeof icon !== "string" || !ICONS.includes(icon)) return r.fail(`${field}.icon`, "a bundled icon name", icon);
    item.icon = icon;
  }
  if (o.description !== undefined) item.description = r.string(o.description, `${field}.description`);
  if (o.image !== undefined) item.image = parseImageRef(r.file, o.image, `${field}.image`);
  if (o.diet !== undefined) {
    if (typeof o.diet !== "string" || !DIETS.includes(o.diet as Diet))
      r.fail(`${field}.diet`, '"veg", "non-veg" or "egg"', o.diet);
    item.diet = o.diet as Diet;
  }
  if (o.available !== undefined) item.available = r.boolean(o.available, `${field}.available`);
  if (o.extras !== undefined) item.extras = idList(r, o.extras, `${field}.extras`);
  if (o.station !== undefined) item.station = r.id(o.station, `${field}.station`);
  return item;
}

function idList(r: Reader, raw: unknown, field: string): string[] {
  const seen = new Set<string>();
  return r.array(raw, field, true).map((v, i) => {
    const id = r.id(v, `${field}[${i}]`);
    r.unique(seen, id, `${field}[${i}]`, "group id");
    return id;
  });
}

function parseExtraGroups(r: Reader, raw: unknown, field: string): ExtraGroup[] {
  const groupIds = new Set<string>();
  const optionIds = new Set<string>();
  return r.array(raw, field, true).map((g, gi) => {
    const gf = `${field}[${gi}]`;
    const go = r.object(g, gf);
    const id = r.id(go.id, `${gf}.id`);
    r.unique(groupIds, id, `${gf}.id`, "extras group id");
    const name = r.string(go.name, `${gf}.name`);
    const options = r.array(go.options, `${gf}.options`, true).map((o, oi): ExtraOption => {
      const of = `${gf}.options[${oi}]`;
      const oo = r.object(o, of);
      const oid = r.id(oo.id, `${of}.id`);
      r.unique(optionIds, oid, `${of}.id`, "option id across all extras groups");
      return { id: oid, name: r.string(oo.name, `${of}.name`), price: r.minorOrZero(oo.price, `${of}.price`) };
    });
    const count = (v: unknown, f: string, lo: number, fallback: number): number => {
      if (v === undefined) return fallback;
      if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > options.length) {
        return r.fail(f, `a whole number from ${lo} to ${options.length} (the group's options)`, v);
      }
      return v;
    };
    const min = count(go.min, `${gf}.min`, 0, 0);
    const max = count(go.max, `${gf}.max`, 1, options.length);
    if (min > max) r.failText(`${gf}.min`, `a min up to the max (${max})`, String(min));
    return { id, name, min, max, options };
  });
}

export function parseCatalog(raw: unknown, file = "catalog.json"): Catalog {
  const r = new Reader(file);
  const o = r.object(raw, "");
  const categoryIds = new Set<string>();
  const itemIds = new Set<string>();
  const filterIds = new Set<string>();
  const filters =
    o.filters === undefined
      ? undefined
      : r.array(o.filters, "filters", true).map((f, i): MenuFilter => {
          const ff = `filters[${i}]`;
          const fo = r.object(f, ff);
          const id = r.id(fo.id, `${ff}.id`);
          r.unique(filterIds, id, `${ff}.id`, "filter id");
          const mode: unknown = fo.mode === undefined ? "include" : fo.mode;
          if (mode !== "include" && mode !== "exclude") return r.fail(`${ff}.mode`, '"include" or "exclude"', mode);
          return { id, name: r.string(fo.name, `${ff}.name`), tag: r.string(fo.tag, `${ff}.tag`), mode };
        });
  const extras = o.extras === undefined ? undefined : parseExtraGroups(r, o.extras, "extras");
  const known = new Set((extras ?? []).map((g) => g.id));
  const knownGroups = (ids: string[], field: string): string[] => {
    ids.forEach((id, i) => {
      if (!known.has(id)) r.fail(`${field}[${i}]`, "a group id from the catalog's extras", id);
    });
    return ids;
  };
  const categories = r.array(o.categories, "categories", true).map((c, ci) => {
    const cf = `categories[${ci}]`;
    const co = r.object(c, cf);
    const id = r.id(co.id, `${cf}.id`);
    r.unique(categoryIds, id, `${cf}.id`, "category id");
    const name = r.string(co.name, `${cf}.name`);
    const items = r.array(co.items, `${cf}.items`).map((it, ii) => {
      const item = parseItem(r, it, `${cf}.items[${ii}]`);
      if (item.extras) knownGroups(item.extras, `${cf}.items[${ii}].extras`);
      r.unique(itemIds, item.id, `${cf}.items[${ii}].id`, "item id across the catalog");
      return item;
    });
    const category: Category = { id, name, items };
    if (co.icon !== undefined) {
      const icon = co.icon;
      if (typeof icon !== "string" || !ICONS.includes(icon))
        return r.fail(`${cf}.icon`, "a bundled icon name", co.icon);
      category.icon = icon;
    }
    if (co.extras !== undefined) category.extras = knownGroups(idList(r, co.extras, `${cf}.extras`), `${cf}.extras`);
    return category;
  });
  return {
    categories,
    ...(extras === undefined ? {} : { extras }),
    ...(filters === undefined ? {} : { filters }),
  };
}

/** Stations are validated against the catalog: every category maps to exactly one station. */
export function parseStations(raw: unknown, catalog: Catalog, file = "stations.json"): Station[] {
  const r = new Reader(file);
  const known = new Set(catalog.categories.map((c) => c.id));
  const owner = new Map<string, string>();
  const stationIds = new Set<string>();
  const stations = r.array(raw, "", true).map((s, si): Station => {
    const sf = `[${si}]`;
    const so = r.object(s, sf);
    const id = r.id(so.id, `${sf}.id`);
    r.unique(stationIds, id, `${sf}.id`, "station id");
    const name = r.string(so.name, `${sf}.name`);
    const categories = r.array(so.categories, `${sf}.categories`, true).map((c, ci) => {
      const field = `${sf}.categories[${ci}]`;
      const cat = r.id(c, field);
      if (!known.has(cat)) r.fail(field, "a category id from the catalog", cat);
      const prev = owner.get(cat);
      if (prev !== undefined) {
        r.failText(field, "a category no other station prepares", `${JSON.stringify(cat)} already on station ${prev}`);
      }
      owner.set(cat, id);
      return cat;
    });
    const view =
      so.view === undefined
        ? "batch"
        : so.view === "batch" || so.view === "jobs"
          ? so.view
          : r.fail(`${sf}.view`, '"batch" or "jobs"', so.view);
    const speak = r.boolean(so.speak, `${sf}.speak`);
    const print =
      so.print === null || so.print === "ticket-80mm"
        ? so.print
        : r.fail(`${sf}.print`, '"ticket-80mm" or null', so.print);
    return { id, name, categories, view, speak, print };
  });
  for (const cat of known) {
    if (!owner.has(cat))
      r.failText("", "a station for every catalog category", `no station for ${JSON.stringify(cat)}`);
  }
  for (const c of catalog.categories) {
    for (const item of c.items) {
      if (item.station !== undefined && !stationIds.has(item.station)) {
        throw new ConfigError(
          "catalog.json",
          `item ${item.id}.station`,
          `a station id from ${file}`,
          JSON.stringify(item.station),
        );
      }
    }
  }
  return stations;
}

/**
 * `spots.json`: an array of zones (empty when the business has no spots), each `{id, name}` with either `spots: ["Hammock", "Corner"]` or `count: 12` (and an
 * optional `prefix`, so `prefix: "T", count: 3` is T1, T2, T3). A spot's label is the zone's name and its own: "Garden T4".
 */
export function parseSpots(raw: unknown, file = "spots.json"): Zone[] {
  const r = new Reader(file);
  const zoneIds = new Set<string>();
  const spotIds = new Set<string>();
  const labels = new Set<string>();
  return r.array(raw, "").map((z, zi): Zone => {
    const zf = `[${zi}]`;
    const zo = r.object(z, zf);
    const id = r.id(zo.id, `${zf}.id`);
    r.unique(zoneIds, id, `${zf}.id`, "zone id");
    const name = r.string(zo.name, `${zf}.name`);
    if (zo.kind !== undefined && zo.kind !== "room" && zo.kind !== "table") {
      r.fail(`${zf}.kind`, '"room" or "table" (the default)', zo.kind);
    }
    if ((zo.spots !== undefined) === (zo.count !== undefined)) {
      r.failText(zf, "exactly one of spots or count", zo.spots === undefined ? "neither" : "both");
    }
    let own: string[];
    if (zo.spots !== undefined) {
      own = r.array(zo.spots, `${zf}.spots`, true).map((s, i) => r.string(s, `${zf}.spots[${i}]`));
    } else {
      const n = zo.count;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 500) {
        return r.fail(`${zf}.count`, "a whole number from 1 to 500", n);
      }
      const prefix = zo.prefix === undefined ? "" : r.string(zo.prefix, `${zf}.prefix`);
      own = Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
    }
    const spots = own.map((label, i): Spot => {
      const slug = label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      const field = `${zf}.spots[${i}]`;
      if (slug === "") r.fail(field, "a label with a letter or digit", label);
      const spot = { id: `${id}-${slug}`, label: `${name} ${label}` };
      r.unique(spotIds, spot.id, field, "spot within the config");
      r.unique(labels, spot.label, field, "spot label");
      return spot;
    });
    return zo.kind === "room" ? { id, name, kind: "room", spots } : { id, name, spots };
  });
}

/** Validates all the files together; throws ConfigError on the first problem. */
export function loadConfig(raw: RawConfig): Config {
  const business = parseBusiness(raw.business);
  const catalog = parseCatalog(raw.catalog);
  const stations = parseStations(raw.stations, catalog);
  const zones = raw.spots === undefined ? [] : parseSpots(raw.spots);
  const spots = new Map<string, Spot>();
  for (const z of zones) for (const s of z.spots) spots.set(s.id, s);
  const extraGroups = new Map<string, ExtraGroup>();
  for (const g of catalog.extras ?? []) extraGroups.set(g.id, g);
  const items = new Map<string, { item: CatalogItem; categoryId: string }>();
  for (const c of catalog.categories) for (const item of c.items) items.set(item.id, { item, categoryId: c.id });
  const stationByCategory = new Map<string, Station>();
  for (const s of stations) for (const c of s.categories) stationByCategory.set(c, s);
  return { business, catalog, stations, items, stationByCategory, zones, spots, extraGroups };
}

/**
 * The config with the owner's availability switches applied (item id to on or off, kept by the store). Ids no longer
 * in the catalog are ignored, so a catalog edit never breaks boot. The original is left as it is.
 */
export function withAvailability(config: Config, switches: ReadonlyMap<string, boolean>): Config {
  if (switches.size === 0) return config;
  const catalog: Catalog = {
    categories: config.catalog.categories.map((c) => ({
      ...c,
      items: c.items.map((item) => {
        const on = switches.get(item.id);
        return on === undefined ? item : { ...item, available: on };
      }),
    })),
  };
  const items = new Map<string, { item: CatalogItem; categoryId: string }>();
  for (const c of catalog.categories) for (const item of c.items) items.set(item.id, { item, categoryId: c.id });
  return { ...config, catalog, items };
}

/** The one station that prepares an item. Throws if the item is not in the catalog. */
export function stationFor(config: Config, itemId: string): Station {
  const entry = config.items.get(itemId);
  if (entry === undefined) {
    throw new Error(`stationFor: expected an item id from the catalog, found ${JSON.stringify(itemId)}`);
  }
  if (entry.item.station !== undefined) {
    const own = config.stations.find((s) => s.id === entry.item.station);
    if (own === undefined) {
      throw new Error(`stationFor: expected station ${JSON.stringify(entry.item.station)} of ${itemId}, found none`);
    }
    return own;
  }
  const station = config.stationByCategory.get(entry.categoryId);
  if (station === undefined) {
    throw new Error(`stationFor: expected a station for category ${JSON.stringify(entry.categoryId)}, found none`);
  }
  return station;
}

/** The extras groups offered on an item: its category's first, then its own, each once. Empty when it takes none. */
export function extraGroupsFor(config: Config, itemId: string): ExtraGroup[] {
  const entry = config.items.get(itemId);
  if (entry === undefined) return [];
  const category = config.catalog.categories.find((c) => c.id === entry.categoryId);
  const ids = [...new Set([...(category?.extras ?? []), ...(entry.item.extras ?? [])])];
  return ids.flatMap((id) => {
    const g = config.extraGroups.get(id);
    return g === undefined ? [] : [g];
  });
}

/** Whether a spot id is a room: a spot of a zone of kind `room` in `spots.json` (D-082). */
export function isRoom(config: Pick<Config, "zones">, spotId: string): boolean {
  return config.zones.some((z) => z.kind === "room" && z.spots.some((s) => s.id === spotId));
}
