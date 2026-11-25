import { describe, expect, test } from "vitest";
import { ConfigError, parseBusiness } from "../src/core/config.ts";
import { closedDayAt, isOpenAt, nextOpenDay, parseHours, takesOrdersAt, weekdayAt } from "../src/core/hours.ts";

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

describe("last order", () => {
  const tz = "Europe/Lisbon";
  const at = (hh: number, mm: number) => Date.UTC(2026, 11, 1, hh, mm);
  const hours = { open: "09:00", close: "19:00", lastOrder: "18:30" };

  test("orders are taken until the last-order time and refused after it", () => {
    expect(takesOrdersAt(hours, at(18, 30), tz)).toBe(true);
    expect(takesOrdersAt(hours, at(18, 31), tz)).toBe(false);
    expect(takesOrdersAt(hours, at(9, 0), tz)).toBe(true);
  });

  test("without a last-order time the hours only describe the shop", () => {
    expect(takesOrdersAt({ open: "09:00", close: "19:00" }, at(23, 0), tz)).toBe(true);
  });

  test("works past midnight, and a last order outside the open hours is refused", () => {
    const late = { open: "18:00", close: "02:00", lastOrder: "01:00" };
    expect(takesOrdersAt(late, at(0, 30), tz)).toBe(true);
    expect(takesOrdersAt(late, at(1, 30), tz)).toBe(false);
    expect(parseHours("09:00", "19:00", "20:00")).toBeUndefined();
    expect(parseHours("09:00", "19:00", "18:30")).toEqual({ open: "09:00", close: "19:00", lastOrder: "18:30" });
  });
});

describe("closed days", () => {
  // 25 November 2026 is a Wednesday in India.
  const hours = parseHours("09:00", "19:30", "19:00", ["wed"]);
  test("a closed day is shut all day: not open, no orders, and the next open day is the day after", () => {
    expect(hours).toEqual({ open: "09:00", close: "19:30", lastOrder: "19:00", closedDays: ["wed"] });
    const h = hours as NonNullable<typeof hours>;
    expect(isOpenAt(h, at(10), IST)).toBe(false);
    expect(takesOrdersAt(h, at(10), IST)).toBe(false);
    expect(weekdayAt(nextOpenDay(h, at(10), IST), IST)).toBe("thu");
    const thursday = at(10) + 86_400_000;
    expect(isOpenAt(h, thursday, IST)).toBe(true);
    expect(nextOpenDay(h, thursday, IST)).toBe(thursday);
  });

  test("a closed day must be a weekday code, and a business can't be closed every day", () => {
    expect(parseHours("09:00", "19:00", undefined, ["monday"])).toBeUndefined();
    expect(parseHours("09:00", "19:00", undefined, "mon")).toBeUndefined();
    expect(parseHours("09:00", "19:00", undefined, ["sun", "mon", "tue", "wed", "thu", "fri", "sat"])).toBeUndefined();
    expect(parseHours("09:00", "19:00", undefined, [])).toEqual({ open: "09:00", close: "19:00" });
  });
});

describe("closed days past midnight and over clock changes", () => {
  const LIS = "Europe/Lisbon";
  // 18:00 to 02:00, shut on Mondays. 30 November 2026 is a Monday; Lisbon is UTC+0 in winter.
  const late = parseHours("18:00", "02:00", undefined, ["mon"]) as NonNullable<ReturnType<typeof parseHours>>;

  test("the hours after midnight belong to the day the business opened", () => {
    const mon0100 = Date.UTC(2026, 10, 30, 1, 0); // Sunday night's trade
    const mon1900 = Date.UTC(2026, 10, 30, 19, 0);
    const tue0100 = Date.UTC(2026, 11, 1, 1, 0); // Monday night: shut
    const tue1900 = Date.UTC(2026, 11, 1, 19, 0);
    expect(closedDayAt(late, mon0100, LIS)).toBe(false);
    expect(isOpenAt(late, mon0100, LIS)).toBe(true);
    expect(takesOrdersAt(late, mon0100, LIS)).toBe(true);
    expect(closedDayAt(late, mon1900, LIS)).toBe(true);
    expect(isOpenAt(late, mon1900, LIS)).toBe(false);
    expect(closedDayAt(late, tue0100, LIS)).toBe(true);
    expect(isOpenAt(late, tue0100, LIS)).toBe(false);
    expect(closedDayAt(late, tue1900, LIS)).toBe(false);
    // Shut on Monday night, it opens again on Tuesday at 18:00.
    expect(nextOpenDay(late, tue0100, LIS)).toBe(Date.UTC(2026, 11, 1, 18, 0));
  });

  test("the next open day steps by calendar day, so a clock change can't skip one", () => {
    // Shut on Saturdays. Lisbon moves to UTC+1 at 01:00 on Sunday 29 March 2026, a 23-hour day.
    const sat = parseHours("09:00", "19:00", undefined, ["sat"]) as NonNullable<ReturnType<typeof parseHours>>;
    const sat2330 = Date.UTC(2026, 2, 28, 23, 30);
    const next = nextOpenDay(sat, sat2330, LIS);
    expect(weekdayAt(next, LIS)).toBe("sun");
    expect(next).toBe(Date.UTC(2026, 2, 29, 8, 0)); // 09:00 summer time
  });
});
