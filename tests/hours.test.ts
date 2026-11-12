import { describe, expect, test } from "vitest";
import { ConfigError, parseBusiness } from "../src/core/config.ts";
import { isOpenAt, parseHours } from "../src/core/hours.ts";

const IST = "Asia/Kolkata";
const at = (h: number, m = 0) => Date.UTC(2026, 10, 25, h, m) - 330 * 60_000;

describe("opening hours", () => {
  test("open from opening time up to, not including, closing time, in the business's zone", () => {
    const hours = { open: "07:00", close: "22:00" };
    expect(isOpenAt(hours, at(6, 59), IST)).toBe(false);
    expect(isOpenAt(hours, at(7), IST)).toBe(true);
    expect(isOpenAt(hours, at(21, 59), IST)).toBe(true);
    expect(isOpenAt(hours, at(22), IST)).toBe(false);
  });

  test("closing before opening means past midnight", () => {
    const hours = { open: "18:00", close: "02:00" };
    expect(isOpenAt(hours, at(23), IST)).toBe(true);
    expect(isOpenAt(hours, at(1, 30), IST)).toBe(true);
    expect(isOpenAt(hours, at(12), IST)).toBe(false);
  });

  test("only well-formed times count", () => {
    expect(parseHours("7:00", "22:00")).toBeUndefined();
    expect(parseHours("07:00", "24:00")).toBeUndefined();
    expect(parseHours("07:00", "22:00")).toEqual({ open: "07:00", close: "22:00" });
  });

  test("business.json may carry hours; a bad one names the path", () => {
    const base = { name: "B", currency: "USD", timeZone: "America/New_York" };
    expect(parseBusiness({ ...base, hours: { open: "08:00", close: "17:30" } }).hours).toEqual({
      open: "08:00",
      close: "17:30",
    });
    expect(parseBusiness(base).hours).toBeUndefined();
    try {
      parseBusiness({ ...base, hours: { open: "8am", close: "17:30" } });
      throw new Error("expected a ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).field).toBe("hours");
    }
  });
});
