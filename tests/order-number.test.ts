import { describe, expect, test } from "vitest";
import { orderNumber, orderNumbers, tokenForNumber } from "../src/core/tokens.ts";

describe("order numbers (M13)", () => {
  test("a token reads as its number; the day stays in the data", () => {
    expect(orderNumber("25-047")).toBe("#47");
    expect(orderNumber("01-001")).toBe("#1");
    expect(orderNumber("25-1204")).toBe("#1204");
    expect(orderNumber("walk-in")).toBe("walk-in");
    expect(orderNumbers("25-001, 25-014 and 25-1000")).toBe("#1, #14 and #1000");
  });

  test("a person may type the number alone; it means today's order", () => {
    expect(tokenForNumber("47", "2026-11-25")).toBe("25-047");
    expect(tokenForNumber(" #7 ", "2026-11-05")).toBe("05-007");
    expect(tokenForNumber("25-047", "2026-11-26")).toBe("25-047");
    expect(tokenForNumber("1204", "2026-11-25")).toBe("25-1204");
    expect(tokenForNumber("0", "2026-11-25")).toBeUndefined();
    expect(tokenForNumber("abc", "2026-11-25")).toBeUndefined();
  });
});
