/**
 * Search on the counter, stations and runner (D-106). Digits find an order by the end of its number ("39" finds 26-039,
 * as the guest reads it out); anything with a letter finds a spot's label or a guest's name, in any case. Pure.
 */

export interface Searchable {
  token: string;
  spot?: string | undefined;
  customerName?: string | undefined;
}

export function matchesSearch(order: Searchable, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return false;
  if (/^[\d-]+$/.test(q)) {
    const digits = q.replace(/-/g, "");
    return digits !== "" && order.token.replace(/-/g, "").endsWith(digits);
  }
  return [order.spot, order.customerName].some((s) => s?.toLowerCase().includes(q) === true);
}

/** The matches first and the rest after, each in the queue's own order; with no match the queue is as it was. */
export function searchFirst<T extends Searchable>(queue: readonly T[], query: string): { list: T[]; matched: Set<T> } {
  const matched = new Set(queue.filter((o) => matchesSearch(o, query)));
  if (matched.size === 0) return { list: [...queue], matched };
  return { list: [...queue.filter((o) => matched.has(o)), ...queue.filter((o) => !matched.has(o))], matched };
}
