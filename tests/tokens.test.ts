import { describe, expect, test } from "vitest";
import { dayKey, nextToken } from "../src/core/tokens.ts";

const IST = "Asia/Kolkata";
// 2026-11-26 23:59:59 IST is 18:29:59 UTC; IST midnight is 18:30 UTC.
const beforeMidnightIst = Date.UTC(2026, 10, 26, 18, 29, 59);
const afterMidnightIst = Date.UTC(2026, 10, 26, 18, 30, 0);

describe("tokens", () => {
  test("the day is taken in the business's timezone", () => {
    expect(dayKey(beforeMidnightIst, IST)).toBe("2026-11-26");
    expect(dayKey(afterMidnightIst, IST)).toBe("2026-11-27");
    expect(dayKey(afterMidnightIst, "UTC")).toBe("2026-11-26");
  });

  test("the first token of a day is DD-001", () => {
    expect(nextToken(null, beforeMidnightIst, IST)).toEqual({
      token: "26-001",
      counter: { day: "2026-11-26", value: 1 },
    });
  });

  test("the counter increments within a day", () => {
    const next = nextToken({ day: "2026-11-26", value: 41 }, beforeMidnightIst, IST);
    expect(next.token).toBe("26-042");
  });

  test("rolls over at IST midnight, not UTC midnight", () => {
    const counter = { day: "2026-11-26", value: 299 };
    expect(nextToken(counter, beforeMidnightIst, IST).token).toBe("26-300");
    expect(nextToken(counter, afterMidnightIst, IST)).toEqual({
      token: "27-001",
      counter: { day: "2026-11-27", value: 1 },
    });
    // Still 26 November in UTC, so a UTC business would not roll over yet.
    expect(nextToken(counter, afterMidnightIst, "UTC").token).toBe("26-300");
  });

  test("rolls over across a month end", () => {
    const counter = { day: "2026-11-30", value: 7 };
    expect(nextToken(counter, Date.UTC(2026, 10, 30, 18, 30), IST).token).toBe("01-001");
  });

  test("never wraps past 999: the sequence widens instead of colliding", () => {
    expect(nextToken({ day: "2026-11-26", value: 999 }, beforeMidnightIst, IST).token).toBe("26-1000");
  });

  test("a counter from a later day is a bug, not a rollover", () => {
    expect(() => nextToken({ day: "2026-11-27", value: 3 }, beforeMidnightIst, IST)).toThrow(
      "expected a counter from 2026-11-26 or earlier, found 2026-11-27",
    );
  });

  test("rejects a counter value that is not a non-negative integer", () => {
    expect(() => nextToken({ day: "2026-11-26", value: 1.5 }, beforeMidnightIst, IST)).toThrow("non-negative integer");
  });
});
