/** The cart: lines of item, size, extras, note and quantity, each capped at the business's `maxQtyPerLine`. Pure. */

export interface CartLine {
  itemId: string;
  size?: string;
  /** Ids of the extras options picked. */
  extras?: string[];
  note?: string;
  qty: number;
}

export type Cart = readonly CartLine[];

/** What besides item and size tells one line from another. */
export interface Variant {
  extras?: readonly string[];
  note?: string;
}

const extrasKey = (extras: readonly string[] | undefined) => [...(extras ?? [])].sort().join(",");

const same = (l: CartLine, itemId: string, size: string | undefined, v: Variant | undefined) =>
  l.itemId === itemId &&
  l.size === size &&
  extrasKey(l.extras) === extrasKey(v?.extras) &&
  (l.note ?? "") === (v?.note ?? "");

const lineOf = (itemId: string, size: string | undefined, v: Variant | undefined, qty: number): CartLine => ({
  itemId,
  ...(size === undefined ? {} : { size }),
  ...(v?.extras && v.extras.length > 0 ? { extras: [...v.extras] } : {}),
  ...(v?.note ? { note: v.note } : {}),
  qty,
});

/** Sets a line's quantity, clamped to `max`; zero or less removes it. A new line goes at the end. */
export function setQty(
  cart: Cart,
  itemId: string,
  size: string | undefined,
  qty: number,
  max: number,
  variant?: Variant,
): Cart {
  const clamped = Math.min(Math.max(0, Math.floor(qty)), max);
  const at = cart.findIndex((l) => same(l, itemId, size, variant));
  if (at === -1) {
    if (clamped === 0) return cart;
    return [...cart, lineOf(itemId, size, variant, clamped)];
  }
  if (clamped === 0) return cart.filter((_, i) => i !== at);
  return cart.map((l, i) => (i === at ? { ...l, qty: clamped } : l));
}

/** Sets the quantity of the line at `index` (the cart page shows lines by position); zero removes it. */
export function setQtyAt(cart: Cart, index: number, qty: number, max: number): Cart {
  const clamped = Math.min(Math.max(0, Math.floor(qty)), max);
  if (clamped === 0) return cart.filter((_, i) => i !== index);
  return cart.map((l, i) => (i === index ? { ...l, qty: clamped } : l));
}

/** Sets or clears the note of the line at `index`; a line then equal to another is merged into it. */
export function setNoteAt(cart: Cart, index: number, note: string, max: number): Cart {
  const text = note.trim();
  const target = cart[index];
  if (target === undefined) return cart;
  const { note: _old, ...rest } = target;
  const changed: CartLine = text === "" ? rest : { ...rest, note: text };
  const without = cart.filter((_, i) => i !== index);
  const twin = without.findIndex((l) => same(l, changed.itemId, changed.size, changed));
  const other = without[twin];
  // Two lines that would merge past the cap stay two: a merge must never drop units silently.
  if (other === undefined || other.qty + changed.qty > max) return cart.map((l, i) => (i === index ? changed : l));
  return without.map((l, i) => (i === twin ? { ...l, qty: l.qty + changed.qty } : l));
}

export function qtyOf(cart: Cart, itemId: string, size?: string, variant?: Variant): number {
  return cart.find((l) => same(l, itemId, size, variant))?.qty ?? 0;
}

/** Units of an item on the cart whatever their size, extras or note: what an item's card shows as its count. */
export function itemQty(cart: Cart, itemId: string): number {
  return cart.reduce((n, l) => (l.itemId === itemId ? n + l.qty : n), 0);
}

/** One more of the item, unless the line is already at `max`. */
export function addOne(cart: Cart, itemId: string, size: string | undefined, max: number, variant?: Variant): Cart {
  return setQty(cart, itemId, size, qtyOf(cart, itemId, size, variant) + 1, max, variant);
}

export function itemCount(cart: Cart): number {
  return cart.reduce((n, l) => n + l.qty, 0);
}

/** Total in minor units. A line whose price is unknown (the item was withdrawn) counts as zero; the server refuses it. */
export function cartTotal(
  cart: Cart,
  price: (itemId: string, size?: string, extras?: readonly string[]) => number | undefined,
): number {
  return cart.reduce((sum, l) => sum + (price(l.itemId, l.size, l.extras) ?? 0) * l.qty, 0);
}

/** A cart from an order's lines, for editing; repeated lines of the same item, size, extras and note are merged. */
export function cartFromLines(lines: readonly CartLine[], max: number): Cart {
  let cart: Cart = [];
  for (const l of lines) cart = setQty(cart, l.itemId, l.size, qtyOf(cart, l.itemId, l.size, l) + l.qty, max, l);
  return cart;
}
