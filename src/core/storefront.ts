/**
 * Two figures the storefront may show, both computed from what really happened and both absent when there isn't
 * enough of it to say: the typical wait from order to ready, and which items are the bestsellers. Pure: the store
 * hands over aggregates (D-049), these turn them into what a page shows. No names.
 */

/** Fewest finished orders a typical wait is quoted from. */
export const MIN_WAIT_SAMPLE = 5;
/** Fewest units an item needs before it is called a bestseller or popular. */
export const MIN_POPULAR_UNITS = 5;

/**
 * The median of the waits (ms from placing to completing) in whole minutes, or undefined with fewer than
 * `MIN_WAIT_SAMPLE`. At least 1 minute: a figure of "0 min" would promise nothing.
 */
export function typicalWaitMinutes(waitsMs: readonly number[]): number | undefined {
  const waits = waitsMs.filter((w) => w >= 0).sort((a, b) => a - b);
  if (waits.length < MIN_WAIT_SAMPLE) return undefined;
  const mid = waits.length >> 1;
  const median =
    waits.length % 2 === 1 ? (waits[mid] as number) : ((waits[mid - 1] as number) + (waits[mid] as number)) / 2;
  return Math.max(1, Math.round(median / 60_000));
}

export type PopularTag = "bestseller" | "popular";

/** The best sellers, most units first: the top one is a bestseller, the next two popular; under `MIN_POPULAR_UNITS` none. */
export function popularTags(top: readonly { itemId: string; qty: number }[]): Record<string, PopularTag> {
  const out: Record<string, PopularTag> = {};
  top
    .filter((s) => s.qty >= MIN_POPULAR_UNITS)
    .slice(0, 3)
    .forEach((s, i) => {
      out[s.itemId] = i === 0 ? "bestseller" : "popular";
    });
  return out;
}

/** Orders ahead of this one: open (not completed) orders placed before it. Counts only, no one's details. */
export function ordersAhead(
  order: { createdAt: number; id: string },
  open: readonly { createdAt: number; id: string; status: string }[],
): number {
  return open.filter((o) => o.id !== order.id && o.status !== "completed" && o.createdAt < order.createdAt).length;
}
