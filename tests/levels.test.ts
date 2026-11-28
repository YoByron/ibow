/** The one table of who may do what (D-072): pure, complete, and the same in the docs. */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { can, LEVELS, mayRefund, POWERS, powerTableMarkdown, refundCeiling, TABLE } from "../src/core/levels.ts";

describe("the powers table", () => {
  test("every power names at least one real level, and has a sentence for the docs and the hub", () => {
    for (const p of POWERS) {
      expect(TABLE[p].levels.length, p).toBeGreaterThan(0);
      for (const l of TABLE[p].levels) expect(LEVELS, p).toContain(l);
      expect(TABLE[p].what.length, p).toBeGreaterThan(10);
    }
  });

  test("each level holds exactly what the plan gives it", () => {
    const held = (l: (typeof LEVELS)[number]) => POWERS.filter((p) => can(l, p));
    expect(held("staff")).toEqual(["orders.view", "orders.run", "hub"]);
    expect(held("manager")).toEqual([
      "orders.view",
      "orders.run",
      "refund",
      "menu.switch",
      "events.manage",
      "sections.edit",
      "flags.ops",
      "hub",
    ]);
    expect(held("owner")).toEqual([
      "orders.view",
      "orders.run",
      "refund",
      "menu.switch",
      "events.manage",
      "sections.edit",
      "reports",
      "staff.manage",
      "look.edit",
      "flags.look",
      "flags.ops",
      "ai.ask",
      "hub",
    ]);
    expect(held("admin")).toEqual(["flags.system", "telemetry", "hub"]);
  });

  test("the admin sees no customer or sales data, and the owner has no system switch", () => {
    for (const p of ["orders.view", "orders.run", "reports", "refund", "menu.switch"] as const) {
      expect(can("admin", p), p).toBe(false);
    }
    expect(can("owner", "flags.system")).toBe(false);
    expect(can("owner", "telemetry")).toBe(false);
  });
});

describe("refund limits", () => {
  test("the owner has none, a manager has the configured one, nobody else may", () => {
    expect(refundCeiling("owner", undefined)).toBeUndefined();
    expect(refundCeiling("manager", 2000)).toBe(2000);
    expect(refundCeiling("manager", undefined)).toBe(0);
    expect(refundCeiling("staff", 2000)).toBe(0);
    expect(refundCeiling("admin", 2000)).toBe(0);
    expect(mayRefund("owner", 10_000_000, undefined)).toBe(true);
    expect(mayRefund("manager", 2000, 2000)).toBe(true);
    expect(mayRefund("manager", 2001, 2000)).toBe(false);
    expect(mayRefund("manager", 1, undefined)).toBe(false);
    expect(mayRefund("staff", 1, 2000)).toBe(false);
  });
});

test("docs/architecture.md carries the same table, word for word", () => {
  const docs = readFileSync(new URL("../docs/architecture.md", import.meta.url), "utf8");
  const [, between] = /<!-- powers:start -->\n([\s\S]*?)\n<!-- powers:end -->/.exec(docs) ?? [];
  expect(between).toBe(powerTableMarkdown());
});
