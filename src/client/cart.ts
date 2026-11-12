/** The cart: lines of item, size and quantity, each capped at the business's `maxQtyPerLine`. Pure. */

export interface CartLine {
  itemId: string;
  size?: string;
  qty: number;
}

export type Cart = readonly CartLine[];

const same = (l: CartLine, itemId: string, size: string | undefined) => l.itemId === itemId && l.size === size;

/** Sets a line's quantity, clamped to `max`; zero or less removes it. A new line goes at the end. */
export function setQty(cart: Cart, itemId: string, size: string | undefined, qty: number, max: number): Cart {
  const clamped = Math.min(Math.max(0, Math.floor(qty)), max);
  const at = cart.findIndex((l) => same(l, itemId, size));
  if (at === -1) {
    if (clamped === 0) return cart;
    return [...cart, { itemId, ...(size === undefined ? {} : { size }), qty: clamped }];
  }
  if (clamped === 0) return cart.filter((_, i) => i !== at);
  return cart.map((l, i) => (i === at ? { ...l, qty: clamped } : l));
}

export function qtyOf(cart: Cart, itemId: string, size?: string): number {
  return cart.find((l) => same(l, itemId, size))?.qty ?? 0;
}

/** One more of the item, unless the line is already at `max`. */
export function addOne(cart: Cart, itemId: string, size: string | undefined, max: number): Cart {
  return setQty(cart, itemId, size, qtyOf(cart, itemId, size) + 1, max);
}

export function itemCount(cart: Cart): number {
  return cart.reduce((n, l) => n + l.qty, 0);
}

/** Total in minor units. A line whose price is unknown (the item was withdrawn) counts as zero; the server refuses it. */
export function cartTotal(cart: Cart, price: (itemId: string, size?: string) => number | undefined): number {
  return cart.reduce((sum, l) => sum + (price(l.itemId, l.size) ?? 0) * l.qty, 0);
}

/** A cart from an order's lines, for editing; repeated item and size pairs are merged. */
export function cartFromLines(lines: readonly CartLine[], max: number): Cart {
  let cart: Cart = [];
  for (const l of lines) cart = setQty(cart, l.itemId, l.size, qtyOf(cart, l.itemId, l.size) + l.qty, max);
  return cart;
}
