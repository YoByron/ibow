/** What the storefront shows of the catalog: available items only, filtered by category and search. Pure. */

import type { CatalogItem, Category, ExtraGroup, ExtraOption, MenuFilter, Zone } from "../core/config.ts";

export interface StoreCatalog {
  business: {
    name: string;
    currency: string;
    timeZone: string;
    maxQtyPerLine: number;
    hours?: { open: string; close: string; lastOrder?: string };
  };
  payments: { upi: boolean; card?: boolean };
  categories: Category[];
  /** What is left today of items the owner counts (item id to units); absent when none is counted. */
  left?: Record<string, number>;
  /** Diet and allergen filter chips, from item tags. */
  filters?: MenuFilter[];
  /** The library of extras groups items and categories name by id. */
  extras?: ExtraGroup[];
  /** Where customers may sit, when the business has set spots up. */
  zones?: Zone[];
}

/** Lower case, accents dropped, so "Cafe" finds "Café". */
function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * Categories with only the items a customer can order that match `query` (every word, anywhere in the item or
 * category name). Categories left empty are dropped. `categoryId` narrows to one category.
 */
export function visibleCategories(
  categories: readonly Category[],
  query = "",
  categoryId?: string,
  filters: readonly MenuFilter[] = [],
): Category[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const out: Category[] = [];
  for (const cat of categories) {
    if (categoryId !== undefined && cat.id !== categoryId) continue;
    const items = cat.items.filter((item) => {
      if (item.available === false) return false;
      if (!filters.every((f) => (item.tags?.includes(f.tag) ?? false) === (f.mode === "include"))) return false;
      const hay = fold(`${item.name} ${cat.name}`);
      return words.every((w) => hay.includes(w));
    });
    if (items.length > 0) out.push({ ...cat, items });
  }
  return out;
}

export function findItem(categories: readonly Category[], itemId: string): CatalogItem | undefined {
  for (const cat of categories) {
    const item = cat.items.find((i) => i.id === itemId);
    if (item !== undefined) return item;
  }
  return undefined;
}

/** Unit price in minor units, or undefined if the item or size no longer exists or is unavailable. */
export function priceOf(categories: readonly Category[], itemId: string, size?: string): number | undefined {
  const item = findItem(categories, itemId);
  if (item === undefined || item.available === false) return undefined;
  if (item.variants === undefined) return size === undefined ? (item.price ?? 0) : undefined;
  return item.variants.find((v) => v.size === size)?.price;
}

/** The extras groups an item offers: its category's first, then its own. */
export function extraGroupsOf(catalog: StoreCatalog, itemId: string): ExtraGroup[] {
  const cat = catalog.categories.find((c) => c.items.some((i) => i.id === itemId));
  const item = cat?.items.find((i) => i.id === itemId);
  const ids = [...new Set([...(cat?.extras ?? []), ...(item?.extras ?? [])])];
  return ids.flatMap((id) => catalog.extras?.find((g) => g.id === id) ?? []);
}

/** The options by id, with their names and prices, in the catalog's order. */
export function extraOptions(catalog: StoreCatalog, ids: readonly string[] | undefined): ExtraOption[] {
  if (ids === undefined || ids.length === 0) return [];
  return (catalog.extras ?? []).flatMap((g) => g.options.filter((o) => ids.includes(o.id)));
}

/** Unit price in minor units with the extras picked, or undefined if the item or size is gone. */
export function priceOfLine(
  catalog: StoreCatalog,
  itemId: string,
  size?: string,
  extras?: readonly string[],
): number | undefined {
  const base = priceOf(catalog.categories, itemId, size);
  return base === undefined ? undefined : base + extraOptions(catalog, extras).reduce((n, o) => n + o.price, 0);
}

/**
 * The tags (lower case) every one of `items` carries: shown on each item of one section they repeat the section's name, so
 * the storefront leaves them out there. One item alone shares nothing, so its tag stays.
 */
export function sharedTags(items: readonly { tags?: readonly string[] }[]): ReadonlySet<string> {
  if (items.length < 2) return new Set();
  const [first, ...rest] = items.map((i) => new Set((i.tags ?? []).map((t) => t.toLowerCase())));
  return new Set([...(first ?? [])].filter((t) => rest.every((s) => s.has(t))));
}
