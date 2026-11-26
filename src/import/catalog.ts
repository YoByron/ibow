/**
 * From the model's menu readings to a catalog that loads (M15, D-092, D-094). Pure code: it checks each reading,
 * makes stable ids, converts prices to integer minor units of the currency, merges pages in order (a section that
 * continues is one category, an item seen twice is one item), maps add-on groups to the extras library (D-064), and
 * proves the result with the catalog parser. Everything a person should look at goes in the review list.
 */

import { KNOWN_TAGS } from "../ai/menu-reader.ts";
import {
  type Catalog,
  type CatalogItem,
  type Category,
  type Diet,
  type ExtraGroup,
  parseCatalog,
} from "../core/config.ts";
import { majorAmount, minorExponent } from "../core/money.ts";
import { ImportError } from "./inputs.ts";

export type ReviewKind =
  | "no price"
  | "odd price"
  | "unreadable name"
  | "unsure"
  | "duplicate"
  | "unknown tag"
  | "unknown diet"
  | "unknown add-on"
  | "unused add-on"
  | "unread part"
  | "no station";

/** One thing a person should check, and the input it came from. */
export interface ReviewItem {
  file: string;
  kind: ReviewKind;
  /** The item (or `group: option`) it is about, as printed. */
  item?: string;
  section?: string;
  detail: string;
}

/** One model reply, parsed, and the input file it read. */
export interface Reading {
  file: string;
  reply: unknown;
}

/** Nothing to import: every reply was unreadable or held no item with a price. Carries the review for the report. */
export class EmptyMenuError extends ImportError {
  readonly review: ReviewItem[];
  constructor(found: string, review: ReviewItem[]) {
    super("the model's readings", "at least one item with a price", found);
    this.review = review;
  }
}

/** The JSON object in a reply (bare, in a code fence, or after a sentence), or why there is none. */
export function parseReply(reply: string): { ok: true; menu: unknown } | { ok: false; reason: string } {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end < start) return { ok: false, reason: `no JSON object in the reply: ${short(reply)}` };
  let menu: unknown;
  try {
    menu = JSON.parse(reply.slice(start, end + 1));
  } catch (e) {
    return { ok: false, reason: `the reply's JSON does not parse (${(e as Error).message}); cut short?` };
  }
  if (!isObject(menu) || !Array.isArray(menu.sections)) {
    return { ok: false, reason: 'expected {"sections": [...]}, found JSON of another shape' };
  }
  return { ok: true, menu };
}

function short(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 80 ? `${t.slice(0, 80)}…` : t;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function text(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
}

const SMALL_WORDS = new Set(["a", "an", "and", "at", "by", "for", "in", "of", "on", "or", "the", "to", "with"]);

/**
 * A name as a menu shows it to a guest, not as the printed menu's typography set it: an all-capitals name ("SHALLOW FRIED
 * IDLY") in title case, keeping short words without vowels as capitals (BBQ, MRP) and small joining words lower case.
 * A name with any lower-case letter is the café's own casing and stays as it is.
 */
export function tidyName(name: string): string {
  if (!/\p{Lu}/u.test(name) || /\p{Ll}/u.test(name)) return name;
  return name
    .toLowerCase()
    .split(/(\s+|-|\/|&)/)
    .map((w, i) => {
      if (/^[^aeiouy]{2,4}$/i.test(w) && /^\p{L}+$/u.test(w)) return w.toUpperCase();
      if (i > 0 && SMALL_WORDS.has(w)) return w;
      return w.replace(/^\p{L}/u, (c) => c.toUpperCase());
    })
    .join("");
}

/** A section's name: all capitals in title case as above, and all lower case ("all day breakfast") with a capital first. */
export function tidySection(name: string): string {
  return /\p{Lu}/u.test(name) ? tidyName(name) : name.replace(/^\p{L}/u, (c) => c.toUpperCase());
}

/** An id from a name: accents dropped, lowercase letters, digits and dashes; empty for a name in another script. */
export function slug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
}

/** What two spellings of one name share ("COFFEE", "Coffee"), so pages merge. */
function key(name: string): string {
  return slug(name) || name.toLowerCase();
}

function unique(base: string, taken: Set<string>): string {
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  taken.add(id);
  return id;
}

interface Price {
  /** Undefined when the printed price is not one number. */
  minor?: number;
  /** Why a person should look: more decimals than the currency has, a negative or a range. */
  odd?: string;
}

/**
 * A price in minor units from the model's number, or a printed price as text ("₹ 1,250.50"); undefined when none
 * was printed. Decimal arithmetic on the digits, so 20.555 rounds half up to 2056 paise, not float's 2055.
 */
export function priceOf(v: unknown, currency: string): Price | undefined {
  let s: string;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return undefined;
    if (v < 0) return { odd: `${v} is below zero` };
    s = /e/i.test(String(v)) ? v.toFixed(12).replace(/\.?0+$/, "") : String(v);
  } else if (typeof v === "string") {
    if (!/\d/.test(v)) return undefined;
    // A currency word or symbol (with its dot) before the number, or after it, is dropped: "Rs. 120", "₹120", "120/-".
    s = v
      .trim()
      .replace(/^(?:\p{Sc}+|[A-Za-z]{1,3}\.?)\s*/u, "")
      .replace(/\s*(?:\p{Sc}+|[A-Za-z]{1,3}\.?|\/-)$/u, "");
    // What is left must be one run of digits and separators: "10-12", "2 for 5" and "-5" are not one price.
    if (!/^\d+(?:[.,]\d+)*$/.test(s)) return { odd: `${JSON.stringify(v)} is not one price` };
    const dot = s.lastIndexOf(".");
    const comma = s.lastIndexOf(",");
    if (dot !== -1 && comma !== -1) s = dot > comma ? s.replaceAll(",", "") : s.replaceAll(".", "").replace(",", ".");
    else if (/^\d{1,3}(,\d{3})+$/.test(s) && minorExponent(currency) !== 3) s = s.replaceAll(",", "");
    else s = s.replace(",", ".");
  } else {
    return undefined;
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return { odd: `${JSON.stringify(v)} is not one price` };
  const exp = minorExponent(currency);
  const [whole = "0", fraction = ""] = s.split(".");
  let minor = Number(whole) * 10 ** exp + Number(fraction.padEnd(exp, "0").slice(0, exp) || "0");
  if (fraction.length > exp && (fraction[exp] ?? "0") >= "5") minor += 1;
  if (!Number.isSafeInteger(minor)) return { odd: `${s} is too large` };
  if (fraction.length > exp) {
    return { minor, odd: `${s} has more decimals than ${currency} uses; rounded to ${majorAmount(minor, currency)}` };
  }
  return { minor };
}

function priceText(item: CatalogItem, currency: string): string {
  if (item.price !== undefined) return majorAmount(item.price, currency);
  return (item.variants ?? []).map((v) => `${v.size} ${majorAmount(v.price, currency)}`).join(", ");
}

const DIETS: readonly string[] = ["veg", "non-veg", "egg"] satisfies Diet[];
const TAGS: ReadonlySet<string> = new Set(KNOWN_TAGS);
/** What a decoder writes for bytes it could not read: a name holding it was misread. Biome would turn an escape into the raw character. */
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd);
/** A price this many times the menu's middle price is probably a misread decimal point (350 for 3.50). */
const OUTLIER = 50;

interface GroupDraft {
  group: ExtraGroup;
  file: string;
  optionKeys: Set<string>;
  /** Option names as printed, with their key, in order; ids are given at the end. */
  options: { key: string; name: string; price: number }[];
  rawMin: unknown;
  rawMax: unknown;
  sections: Map<string, string>;
  used: boolean;
}

interface ItemDraft {
  item: CatalogItem;
  file: string;
  section: string;
  addons: string[];
}

/**
 * The catalog the readings describe, already through `parseCatalog`, and what a person should check. Throws
 * `EmptyMenuError` when no item with a price is left.
 */
export function buildCatalog(
  readings: readonly Reading[],
  currency: string,
  earlier: readonly ReviewItem[] = [],
): { catalog: Catalog; review: ReviewItem[] } {
  const review: ReviewItem[] = [...earlier];
  const flag = (r: ReviewItem) => review.push(r);
  const categories = new Map<string, { category: Category; drafts: ItemDraft[]; byKey: Map<string, ItemDraft> }>();
  const categoryIds = new Set<string>();
  const itemIds = new Set<string>();
  const groups = new Map<string, GroupDraft>();
  const groupIds = new Set<string>();

  for (const { file, reply } of readings) {
    if (!isObject(reply)) continue;
    for (const rawGroup of Array.isArray(reply.addons) ? reply.addons : []) {
      addGroup(rawGroup, file);
    }
    for (const rawSection of Array.isArray(reply.sections) ? reply.sections : []) {
      if (!isObject(rawSection)) continue;
      let name = tidySection(text(rawSection.name));
      if (name === "") {
        name = "Menu";
        flag({ file, kind: "unreadable name", section: name, detail: "a section had no readable name; called Menu" });
      }
      const k = key(name);
      let entry = categories.get(k);
      if (entry === undefined) {
        const id = unique(slug(name) || `section-${categories.size + 1}`, categoryIds);
        entry = { category: { id, name, items: [] }, drafts: [], byKey: new Map() };
        categories.set(k, entry);
      }
      for (const rawItem of Array.isArray(rawSection.items) ? rawSection.items : []) {
        addItem(rawItem, file, entry);
      }
    }
  }

  function addGroup(raw: unknown, file: string): void {
    if (!isObject(raw)) return;
    const name = tidySection(text(raw.name));
    if (name === "") {
      flag({ file, kind: "unreadable name", detail: "an add-on group had no readable name; left out" });
      return;
    }
    const k = key(name);
    let g = groups.get(k);
    if (g === undefined) {
      const id = unique(slug(name) || "extras", groupIds);
      g = {
        group: { id, name, min: 0, max: 1, options: [] },
        file,
        optionKeys: new Set(),
        options: [],
        rawMin: raw.min,
        rawMax: raw.max,
        sections: new Map(),
        used: false,
      };
      groups.set(k, g);
    }
    for (const s of Array.isArray(raw.sections) ? raw.sections : []) {
      const sn = text(s);
      if (sn !== "") g.sections.set(key(sn), sn);
    }
    for (const o of Array.isArray(raw.options) ? raw.options : []) {
      if (!isObject(o)) continue;
      const oname = tidyName(text(o.name));
      const label = `${name}: ${oname || "?"}`;
      if (oname === "") {
        flag({ file, kind: "unreadable name", item: label, detail: "an add-on option had no readable name; left out" });
        continue;
      }
      const ok = key(oname);
      if (g.optionKeys.has(ok)) continue;
      const p = priceOf(o.price, currency);
      if (p?.minor === undefined) {
        const kind = p?.odd === undefined ? "no price" : "odd price";
        flag({ file, kind, item: label, detail: `${p?.odd ?? "no price printed"}; left out (0 means free)` });
        continue;
      }
      if (p.odd !== undefined) flag({ file, kind: "odd price", item: label, detail: p.odd });
      g.optionKeys.add(ok);
      g.options.push({ key: ok, name: oname, price: p.minor });
    }
  }

  function addItem(raw: unknown, file: string, entry: NonNullable<ReturnType<typeof categories.get>>): void {
    const section = entry.category.name;
    if (!isObject(raw)) return;
    const name = tidyName(text(raw.name));
    if (name === "") {
      flag({ file, kind: "unreadable name", section, detail: "an item had no readable name; left out" });
      return;
    }
    const at = { file, item: name, section };
    const unsure = raw.unsure === true || name.includes(REPLACEMENT_CHARACTER);
    if (unsure) {
      flag({
        ...at,
        kind: "unsure",
        detail:
          "the model could not read the name or price clearly; written switched off, so check both and switch it on",
      });
    }
    const item: CatalogItem = { id: "", name };
    // Nobody can order a misread item before a person has looked at it.
    if (unsure) item.available = false;
    const sizes = Array.isArray(raw.sizes) ? raw.sizes : [];
    const variants: { size: string; price: number }[] = [];
    for (const v of sizes) {
      if (!isObject(v)) continue;
      const size = text(v.size);
      const p = priceOf(v.price, currency);
      if (size === "" || p?.minor === undefined || p.minor === 0) {
        const kind = p?.odd === undefined ? "no price" : "odd price";
        flag({ ...at, kind, detail: `a size ${size ? `"${size}" ` : "without a name "}had no usable price; left out` });
        continue;
      }
      if (p.odd !== undefined) flag({ ...at, kind: "odd price", detail: `${size}: ${p.odd}` });
      if (variants.some((x) => x.size === size)) {
        flag({ ...at, kind: "duplicate", detail: `the size "${size}" appears twice; kept the first` });
        continue;
      }
      variants.push({ size, price: p.minor });
    }
    if (variants.length > 0) item.variants = variants;
    else {
      const p = priceOf(raw.price, currency);
      if (p?.minor === undefined || p.minor === 0) {
        const why = p?.odd ?? (p?.minor === 0 ? "a price of 0" : "no price printed");
        flag({ ...at, kind: p === undefined ? "no price" : "odd price", detail: `${why}; left out of catalog.json` });
        return;
      }
      if (p.odd !== undefined) flag({ ...at, kind: "odd price", detail: p.odd });
      item.price = p.minor;
    }
    const description = text(raw.description);
    if (description !== "") item.description = description;
    const tags: string[] = [];
    for (const t of Array.isArray(raw.tags) ? raw.tags : []) {
      const tag = slug(text(t));
      if (tag === "" || tags.includes(tag)) continue;
      tags.push(tag);
      if (!TAGS.has(tag)) {
        flag({ ...at, kind: "unknown tag", detail: `"${tag}" is not one of ${KNOWN_TAGS.join(", ")}; kept` });
      }
    }
    if (tags.length > 0) item.tags = tags;
    const diet = text(raw.diet).toLowerCase();
    if (diet !== "") {
      if (DIETS.includes(diet)) item.diet = diet as Diet;
      else flag({ ...at, kind: "unknown diet", detail: `"${diet}" is not veg, non-veg or egg; left off` });
    }
    const addons = (Array.isArray(raw.addons) ? raw.addons : []).map(text).filter((a) => a !== "");

    const k = key(name);
    const first = entry.byKey.get(k);
    if (first !== undefined) {
      const a = priceText(first.item, currency);
      const b = priceText(item, currency);
      const same = a === b;
      flag({
        ...at,
        kind: "duplicate",
        detail: same
          ? `also in ${first.file} at the same price; merged into one`
          : `${first.file} says ${a}, this says ${b}; kept the first`,
      });
      if (first.item.description === undefined && item.description !== undefined) {
        first.item.description = item.description;
      }
      if (first.item.diet === undefined && item.diet !== undefined) first.item.diet = item.diet;
      if (item.tags) first.item.tags = [...new Set([...(first.item.tags ?? []), ...item.tags])];
      first.addons.push(...addons.filter((x) => !first.addons.includes(x)));
      return;
    }
    const base = slug(name) || `${entry.category.id}-item`;
    for (const other of categories.values()) {
      if (other !== entry && other.byKey.has(k)) {
        flag({ ...at, kind: "duplicate", detail: `the same name is also in ${other.category.name}; both kept` });
      }
    }
    item.id = itemIds.has(base) ? unique(`${entry.category.id}-${base}`, itemIds) : unique(base, itemIds);
    const draft: ItemDraft = { item, file, section, addons };
    entry.byKey.set(k, draft);
    entry.drafts.push(draft);
    entry.category.items.push(item);
  }

  // Add-ons: option ids unique across the library, then each group on its sections and items.
  const optionIds = new Set<string>();
  const library: ExtraGroup[] = [];
  const byKey = new Map<string, GroupDraft>();
  for (const [k, g] of groups) {
    if (g.options.length === 0) {
      flag({ file: g.file, kind: "unused add-on", item: g.group.name, detail: "no option with a price; left out" });
      continue;
    }
    g.group.options = g.options.map((o) => {
      const base = slug(o.name) || "option";
      const id = optionIds.has(base) ? unique(`${g.group.id}-${base}`, optionIds) : unique(base, optionIds);
      return { id, name: o.name, price: o.price };
    });
    const n = g.group.options.length;
    const max = typeof g.rawMax === "number" && Number.isInteger(g.rawMax) && g.rawMax >= 1 && g.rawMax <= n;
    g.group.max = max ? (g.rawMax as number) : n;
    const min = typeof g.rawMin === "number" && Number.isInteger(g.rawMin) && g.rawMin >= 0;
    g.group.min = min ? Math.min(g.rawMin as number, g.group.max) : 0;
    library.push(g.group);
    byKey.set(k, g);
  }
  for (const g of byKey.values()) {
    for (const [sk, sn] of g.sections) {
      const entry = categories.get(sk);
      if (entry === undefined) {
        flag({
          file: g.file,
          kind: "unknown add-on",
          item: g.group.name,
          detail: `names a section "${sn}" not on the menu`,
        });
        continue;
      }
      entry.category.extras = [...(entry.category.extras ?? []), g.group.id];
      if (entry.category.items.length > 0) g.used = true;
    }
  }
  for (const { category, drafts } of categories.values()) {
    for (const d of drafts) {
      const ids: string[] = [];
      for (const name of d.addons) {
        const g = byKey.get(key(name));
        if (g === undefined) {
          flag({
            file: d.file,
            kind: "unknown add-on",
            item: d.item.name,
            section: d.section,
            detail: `"${name}" is not an add-on group on the menu; left off`,
          });
          continue;
        }
        g.used = true;
        if (!(category.extras ?? []).includes(g.group.id) && !ids.includes(g.group.id)) ids.push(g.group.id);
      }
      if (ids.length > 0) d.item.extras = ids;
    }
  }
  for (const g of byKey.values()) {
    if (!g.used) {
      flag({
        file: g.file,
        kind: "unused add-on",
        item: g.group.name,
        detail: `offered on no item; kept in the extras library as "${g.group.id}", add it to an item or category`,
      });
    }
  }

  // A price far above the menu's middle one is probably a misread decimal point.
  const all = [...categories.values()].flatMap((e) => e.drafts);
  const top = (i: CatalogItem) => Math.max(i.price ?? 0, ...(i.variants ?? []).map((v) => v.price));
  const sorted = all.map((d) => top(d.item)).sort((a, b) => a - b);
  const middle = sorted[Math.floor(sorted.length / 2)] ?? 0;
  if (sorted.length >= 5) {
    for (const d of all) {
      if (top(d.item) > OUTLIER * middle) {
        flag({
          file: d.file,
          kind: "odd price",
          item: d.item.name,
          section: d.section,
          detail: `${priceText(d.item, currency)} is over ${OUTLIER} times the menu's middle price (${majorAmount(middle, currency)}); a missing decimal point?`,
        });
      }
    }
  }

  const kept = [...categories.values()].map((e) => e.category).filter((c) => c.items.length > 0);
  if (kept.length === 0) {
    throw new EmptyMenuError(`none (${readings.length} readable replies; see the review)`, review);
  }
  const raw: Catalog = { categories: kept, ...(library.length > 0 ? { extras: library } : {}) };
  return { catalog: parseCatalog(raw, "catalog.json (as import-menu built it)"), review };
}
