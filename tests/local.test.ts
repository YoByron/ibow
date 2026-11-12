import { describe, expect, test } from "vitest";
import {
  addRecent,
  isId,
  isRecent,
  MAX_RECENT,
  parseList,
  type RecentOrder,
  toggleFavourite,
} from "../src/client/local.ts";

const order = (token: string): RecentOrder => ({
  token,
  at: 1,
  totalMinor: 3000,
  lines: [{ itemId: "chai", size: "M", qty: 1, name: "Chai" }],
});

describe("what the phone remembers", () => {
  test("stars toggle", () => {
    expect(toggleFavourite([], "chai")).toEqual(["chai"]);
    expect(toggleFavourite(["chai", "soda"], "chai")).toEqual(["soda"]);
  });

  test("recent orders keep the newest ten, once per token", () => {
    let list: RecentOrder[] = [];
    for (let i = 0; i < 12; i++) list = addRecent(list, order(`01-${String(i).padStart(3, "0")}`));
    expect(list).toHaveLength(MAX_RECENT);
    expect(list[0]?.token).toBe("01-011");
    expect(addRecent(list, order("01-005"))[0]?.token).toBe("01-005");
    expect(addRecent(list, order("01-005"))).toHaveLength(MAX_RECENT);
  });

  test("a damaged store is an empty list", () => {
    expect(parseList("{not json", isId)).toEqual([]);
    expect(parseList('{"a":1}', isId)).toEqual([]);
    expect(parseList('["a", 3, ""]', isId)).toEqual(["a"]);
    expect(parseList(JSON.stringify([order("01-001"), { token: 1 }]), isRecent)).toHaveLength(1);
    expect(parseList(undefined, isId)).toEqual([]);
  });
});
