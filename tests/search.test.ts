/** Search on the counter, stations and runner (D-106): a pure matcher, and matches moved to the top in queue order. */

import { expect, test } from "vitest";
import { matchesSearch, searchFirst } from "../src/core/search.ts";

const a = { token: "26-039", spot: "Garden B1", customerName: "Asha" };
const b = { token: "26-139", customerName: "Ravi" };
const c = { token: "26-040", spot: "Terrace 2" };

test("digits match the end of the order number, as the guest reads it", () => {
  expect(matchesSearch(a, "39")).toBe(true);
  expect(matchesSearch(a, "039")).toBe(true);
  expect(matchesSearch(b, "39")).toBe(true);
  expect(matchesSearch(a, "3")).toBe(false);
  expect(matchesSearch(c, "39")).toBe(false);
  expect(matchesSearch(a, "26-039")).toBe(true);
});

test("letters find a spot or a guest's name, in any case; blank finds nothing", () => {
  expect(matchesSearch(a, "b1")).toBe(true);
  expect(matchesSearch(a, " garden ")).toBe(true);
  expect(matchesSearch(c, "terrace")).toBe(true);
  expect(matchesSearch(b, "rav")).toBe(true);
  expect(matchesSearch(b, "B1")).toBe(false);
  expect(matchesSearch(a, "")).toBe(false);
  expect(matchesSearch(a, "   ")).toBe(false);
});

test("matches move to the top, both groups keep the queue's order; no query keeps the queue as it is", () => {
  const queue = [c, a, b];
  expect(searchFirst(queue, "39")).toEqual({ list: [a, b, c], matched: new Set([a, b]) });
  expect(searchFirst(queue, "")).toEqual({ list: queue, matched: new Set() });
  expect(searchFirst(queue, "zzz")).toEqual({ list: queue, matched: new Set() });
});
