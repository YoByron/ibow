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
  /**
   * Cash amounts the counter offers as one-tap "received" buttons, from `cashShortcuts` in `business.json` (major
   * units, such as `[5, 10, 20, 50]`), kept here in minor units. Absent: the counter derives them from the amount due.
   */
  cashShortcutsMinor?: number[];
  /** `showcase: true` in `business.json` serves the ibow showcase page at `/showcase` on a real install (D-055); a demo always does. */
  showcase?: boolean;
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
}

export interface Category {
  id: string;
  name: string;
  /** A bundled icon name (`ICONS` in theme.ts) shown on the category's chip and heading. */
  icon?: string;
  items: CatalogItem[];
}

export interface Catalog {
  categories: Category[];
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
}

export interface RawConfig {
  business: unknown;
  catalog: unknown;
  stations: unknown;
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
  "cashShortcuts",
  "hours",
  "showcase",
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
  const business: Business = { name, currency, timeZone, maxQtyPerLine, retentionDays };
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
    const hours = parseHours(h.open, h.close);
    if (hours === undefined) return r.fail("hours", "{open, close} as HH:MM, 24 hour, such as 07:00", o.hours);
    business.hours = hours;
  }
  if (o.showcase !== undefined) business.showcase = r.boolean(o.showcase, "showcase");
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
  return item;
}

export function parseCatalog(raw: unknown, file = "catalog.json"): Catalog {
  const r = new Reader(file);
  const o = r.object(raw, "");
  const categoryIds = new Set<string>();
  const itemIds = new Set<string>();
  const categories = r.array(o.categories, "categories", true).map((c, ci) => {
    const cf = `categories[${ci}]`;
    const co = r.object(c, cf);
    const id = r.id(co.id, `${cf}.id`);
    r.unique(categoryIds, id, `${cf}.id`, "category id");
    const name = r.string(co.name, `${cf}.name`);
    const items = r.array(co.items, `${cf}.items`).map((it, ii) => {
      const item = parseItem(r, it, `${cf}.items[${ii}]`);
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
    return category;
  });
  return { categories };
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
  return stations;
}

/** Validates all three files together; throws ConfigError on the first problem. */
export function loadConfig(raw: RawConfig): Config {
  const business = parseBusiness(raw.business);
  const catalog = parseCatalog(raw.catalog);
  const stations = parseStations(raw.stations, catalog);
  const items = new Map<string, { item: CatalogItem; categoryId: string }>();
  for (const c of catalog.categories) for (const item of c.items) items.set(item.id, { item, categoryId: c.id });
  const stationByCategory = new Map<string, Station>();
  for (const s of stations) for (const c of s.categories) stationByCategory.set(c, s);
  return { business, catalog, stations, items, stationByCategory };
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
  const station = config.stationByCategory.get(entry.categoryId);
  if (station === undefined) {
    throw new Error(`stationFor: expected a station for category ${JSON.stringify(entry.categoryId)}, found none`);
  }
  return station;
}
