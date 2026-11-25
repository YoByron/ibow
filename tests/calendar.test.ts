import { describe, expect, test } from "vitest";
import {
  type CalendarEvent,
  EventError,
  expired,
  nextOccurrence,
  parseEvent,
  parseEvents,
  upcoming,
} from "../src/core/calendar.ts";

const ZONE = "Europe/Lisbon";
/** Wednesday 2 December 2026, 11:00 in Lisbon (UTC+0 in winter). */
const WED_11 = Date.UTC(2026, 11, 2, 11, 0);
let n = 0;
const ev = (o: Partial<CalendarEvent>): CalendarEvent => ({
  id: ++n,
  title: "Something",
  date: "2026-12-02",
  start: "10:00",
  audience: "all",
  rush: false,
  ...o,
});

describe("an event's fields", () => {
  test("title, date, start, optional end, note, audience, rush, weekly repeat and price are checked", () => {
    expect(
      parseEvent({
        title: " Folk dance ",
        date: "2026-12-06",
        start: "16:30",
        end: "18:00",
        note: "In the garden",
        audience: "all",
        rush: true,
        repeat: { weekdays: ["sun"], until: "2027-03-28" },
        price: 700,
      }),
    ).toEqual({
      title: "Folk dance",
      date: "2026-12-06",
      start: "16:30",
      end: "18:00",
      note: "In the garden",
      audience: "all",
      rush: true,
      repeat: { weekdays: [0], until: "2027-03-28" },
      price: 700,
    });
    expect(parseEvent({ title: "Market", date: "2026-12-05", start: "09:00" })).toEqual({
      title: "Market",
      date: "2026-12-05",
      start: "09:00",
      audience: "all",
      rush: false,
    });
  });

  test.each([
    [{ date: "2026-12-05", start: "09:00" }, "title"],
    [{ title: "x".repeat(61), date: "2026-12-05", start: "09:00" }, "title"],
    [{ title: "A", date: "2026-02-30", start: "09:00" }, "date"],
    [{ title: "A", date: "2026-12-05", start: "9am" }, "start"],
    [{ title: "A", date: "2026-12-05", start: "09:00", end: "09:00" }, "end"],
    [{ title: "A", date: "2026-12-05", start: "09:00", note: "two\nlines" }, "note"],
    [{ title: "A", date: "2026-12-05", start: "09:00", audience: "vip" }, "audience"],
    [{ title: "A", date: "2026-12-05", start: "09:00", repeat: { weekdays: [] } }, "repeat.weekdays"],
    [{ title: "A", date: "2026-12-05", start: "09:00", repeat: { weekdays: ["fun"] } }, "repeat.weekdays"],
    [
      { title: "A", date: "2026-12-05", start: "09:00", repeat: { weekdays: ["sat"], until: "2026-12-01" } },
      "repeat.until",
    ],
    [{ title: "A", date: "2026-12-05", start: "09:00", price: -1 }, "price"],
    [{ title: "A", date: "2026-12-05", start: "09:00", tickets: 3 }, "tickets"],
  ])("refuses %j at %s", (raw, field) => {
    let err: EventError | undefined;
    try {
      parseEvent(raw);
    } catch (e) {
      err = e as EventError;
    }
    expect(err).toBeInstanceOf(EventError);
    expect(err?.field).toBe(field);
  });

  test("events.json is a list, each checked with its index in the message", () => {
    expect(() => parseEvents([{ title: "A", date: "2026-12-05", start: "09:00" }, {}], "events.json")).toThrow(
      /events\.json \[1\]\.title/,
    );
  });
});

describe("the next occurrence", () => {
  test("a one-off: its day while not over; gone once it ends (or at midnight without an end)", () => {
    const e = ev({ date: "2026-12-02", start: "10:00", end: "12:00" });
    expect(nextOccurrence(e, "2026-12-02", 11 * 60)).toEqual({ day: "2026-12-02", start: "10:00", end: "12:00" });
    expect(nextOccurrence(e, "2026-12-02", 12 * 60)).toBeUndefined();
    expect(nextOccurrence(ev({ date: "2026-12-02", start: "10:00" }), "2026-12-02", 23 * 60)).toBeDefined();
    expect(nextOccurrence(e, "2026-12-03", 0)).toBeUndefined();
    expect(nextOccurrence(e, "2026-11-30", 0)?.day).toBe("2026-12-02");
  });

  test("weekly on some days: the next of those days from its first date, up to its end date", () => {
    // Wednesdays and Saturdays, 12:00 to 15:00, from Wed 2 Dec until Sat 12 Dec.
    const popup = ev({
      date: "2026-12-02",
      start: "12:00",
      end: "15:00",
      repeat: { weekdays: [3, 6], until: "2026-12-12" },
    });
    expect(nextOccurrence(popup, "2026-12-02", 11 * 60)?.day).toBe("2026-12-02");
    expect(nextOccurrence(popup, "2026-12-02", 15 * 60)?.day).toBe("2026-12-05");
    expect(nextOccurrence(popup, "2026-12-06", 0)?.day).toBe("2026-12-09");
    expect(nextOccurrence(popup, "2026-12-12", 14 * 60)?.day).toBe("2026-12-12");
    expect(nextOccurrence(popup, "2026-12-12", 16 * 60)).toBeUndefined();
    // Before its first date it starts on the first matching day on or after it.
    expect(
      nextOccurrence(ev({ date: "2026-12-04", start: "16:30", repeat: { weekdays: [0] } }), "2026-11-20", 0)?.day,
    ).toBe("2026-12-06");
  });
});

describe("who sees what in the next 7 days", () => {
  const today = ev({ title: "Today", date: "2026-12-02", start: "18:00", rush: true });
  const staffOnly = ev({ title: "Delivery", date: "2026-12-05", start: "08:00", audience: "staff" });
  const far = ev({ title: "Far", date: "2026-12-10", start: "10:00" });
  const sunday = ev({ title: "Folk dance", date: "2026-11-01", start: "16:30", repeat: { weekdays: [0] } });
  const all = [far, staffOnly, sunday, today];

  test("guests see only guest-visible events; staff see both; within 7 days; soonest first", () => {
    const guest = upcoming(all, { now: WED_11, timeZone: ZONE, audience: "guest" });
    expect(guest.map((o) => [o.title, o.day, o.inDays])).toEqual([
      ["Today", "2026-12-02", 0],
      ["Folk dance", "2026-12-06", 4],
    ]);
    const staff = upcoming(all, { now: WED_11, timeZone: ZONE, audience: "staff" });
    expect(staff.map((o) => o.title)).toEqual(["Today", "Delivery", "Folk dance"]);
    // Day 7 is in, day 8 is out.
    expect(upcoming([far], { now: Date.UTC(2026, 11, 3, 9), timeZone: ZONE, audience: "guest" })).toHaveLength(1);
    expect(upcoming([far], { now: Date.UTC(2026, 11, 2, 9), timeZone: ZONE, audience: "guest" })).toHaveLength(0);
  });

  test("an occurrence says how many minutes until it starts, on its day", () => {
    const [first] = upcoming([today], { now: WED_11, timeZone: ZONE, audience: "guest" });
    expect(first).toMatchObject({ inDays: 0, startsInMinutes: 7 * 60, rush: true });
  });
});

describe("cleanup", () => {
  test("a one-off goes 2 days after its day; a repeat after its end date; an open-ended repeat stays", () => {
    expect(expired(ev({ date: "2026-12-02" }), "2026-12-04")).toBe(false);
    expect(expired(ev({ date: "2026-12-02" }), "2026-12-05")).toBe(true);
    expect(expired(ev({ date: "2026-11-01", repeat: { weekdays: [0], until: "2026-12-02" } }), "2026-12-05")).toBe(
      true,
    );
    expect(expired(ev({ date: "2026-11-01", repeat: { weekdays: [0], until: "2026-12-02" } }), "2026-12-04")).toBe(
      false,
    );
    expect(expired(ev({ date: "2020-01-01", repeat: { weekdays: [0] } }), "2026-12-05")).toBe(false);
  });
});

describe("an event that ends past midnight", () => {
  test("an end before the start is the next morning; an end equal to the start is refused", () => {
    expect(parseEvent({ title: "Late jazz", date: "2026-12-05", start: "21:00", end: "01:00" }).end).toBe("01:00");
    expect(() => parseEvent({ title: "A", date: "2026-12-05", start: "21:00", end: "21:00" })).toThrow(EventError);
  });

  test("it is on until its end the next morning, then gone; a weekly one moves on to its next night", () => {
    const jazz = ev({ title: "Late jazz", date: "2026-12-05", start: "21:00", end: "01:00" });
    expect(nextOccurrence(jazz, "2026-12-05", 23 * 60)).toEqual({ day: "2026-12-05", start: "21:00", end: "01:00" });
    expect(nextOccurrence(jazz, "2026-12-06", 30)).toEqual({ day: "2026-12-05", start: "21:00", end: "01:00" });
    expect(nextOccurrence(jazz, "2026-12-06", 60)).toBeUndefined();
    const fridays = ev({ date: "2026-12-04", start: "22:00", end: "02:00", repeat: { weekdays: [5] } });
    expect(nextOccurrence(fridays, "2026-12-05", 90)?.day).toBe("2026-12-04");
    expect(nextOccurrence(fridays, "2026-12-05", 150)?.day).toBe("2026-12-11");
    // Saturday 00:30 in Lisbon: Friday's night is on now.
    const [on] = upcoming([jazz], { now: Date.UTC(2026, 11, 6, 0, 30), timeZone: ZONE, audience: "guest" });
    expect(on).toMatchObject({ title: "Late jazz", inDays: 0 });
    expect(on?.startsInMinutes).toBeLessThan(0);
  });
});
