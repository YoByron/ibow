import { describe, expect, test } from "vitest";
import { DRAWINGS } from "../src/client/ui/icons.ts";
import { ICONS } from "../src/core/theme.ts";

describe("the icon set", () => {
  test("every name a config may use has a drawing, and nothing is drawn that cannot be named", () => {
    expect(ICONS.filter((n) => DRAWINGS[n] === undefined)).toEqual([]);
    expect(Object.keys(DRAWINGS).filter((n) => !ICONS.includes(n))).toEqual([]);
  });

  test("each drawing has a line part and only well-formed path data on the 24 px grid", () => {
    for (const [name, parts] of Object.entries(DRAWINGS)) {
      expect(
        parts.some(([kind]) => kind === "s"),
        name,
      ).toBe(true);
      for (const [kind, d] of parts) {
        expect(["s", "f", "d"], name).toContain(kind);
        expect(d, name).toMatch(/^M[-\d. ,MmLlHhVvCcSsQqTtAaZz]+$/);
        const coords = (d.match(/-?\d*\.?\d+/g) ?? []).map(Number);
        expect(Math.max(...coords), name).toBeLessThanOrEqual(24);
      }
    }
  });
});
