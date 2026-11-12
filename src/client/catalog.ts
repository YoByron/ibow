/** What the storefront shows of the catalog: available items only, filtered by category and search. Pure. */

import type { CatalogItem, Category } from "../core/config.ts";

export interface StoreCatalog {
  business: {
    name: string;
    currency: string;
    timeZone: string;
    maxQtyPerLine: number;
    hours?: { open: string; close: string };
  };
  payments: { upi: boolean };
  categories: Category[];
}

/** Lower case, accents dropped, so "Cafe" finds "Café". */
function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * Categories with only the items a customer can order that match `query` (every word, anywhere in the item or
 * category name). Categories left empty are dropped. `categoryId` narrows to one category.
 */
export function visibleCategories(categories: readonly Category[], query = "", categoryId?: string): Category[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const out: Category[] = [];
  for (const cat of categories) {
    if (categoryId !== undefined && cat.id !== categoryId) continue;
    const items = cat.items.filter((item) => {
      if (item.available === false) return false;
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
