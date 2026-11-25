/** A phone with a wrong clock still judges "late" by the server's time (reviewer note on M10). */

import { expect, test } from "vitest";
import { learnSkew, serverNow } from "../src/client/api.ts";

test("the skew is learnt from the Date header, and a missing or odd header changes nothing", () => {
  const server = Date.UTC(2026, 10, 26, 12, 0, 0);
  const phone = server - 7 * 60_000; // seven minutes slow
  learnSkew(new Date(server).toUTCString(), phone);
  const real = Date.now;
  Date.now = () => phone + 60_000;
  try {
    // One minute later by the phone's clock: the server is at 12:01:00 and a half second (the header's rounding).
    expect(Math.abs(serverNow() - (server + 60_000))).toBeLessThanOrEqual(1000);
    learnSkew(null, phone);
    learnSkew("not a date", phone);
    expect(Math.abs(serverNow() - (server + 60_000))).toBeLessThanOrEqual(1000);
  } finally {
    Date.now = real;
  }
});
