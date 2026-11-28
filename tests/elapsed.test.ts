/** The running timer on every open card (D-105): its text and its colour, from the time since ordering. */

import { expect, test } from "vitest";
import { ageTone, elapsedText } from "../src/core/elapsed.ts";

const S = 1000;
const MIN = 60 * S;

test("m:ss under an hour, then h:mm; never negative", () => {
  expect(elapsedText(0)).toBe("0:00");
  expect(elapsedText(9 * S)).toBe("0:09");
  expect(elapsedText(5 * MIN + 7 * S + 999)).toBe("5:07");
  expect(elapsedText(59 * MIN + 59 * S)).toBe("59:59");
  expect(elapsedText(60 * MIN)).toBe("1:00");
  expect(elapsedText(2 * 60 * MIN + 5 * MIN + 30 * S)).toBe("2:05");
  // A phone's clock a little ahead of the order's: still 0:00.
  expect(elapsedText(-3 * S)).toBe("0:00");
});

test("amber past half the late time, red past it", () => {
  const late = 10 * MIN;
  expect(ageTone(4 * MIN, late)).toBe("fresh");
  expect(ageTone(5 * MIN, late)).toBe("fresh");
  expect(ageTone(5 * MIN + S, late)).toBe("warn");
  expect(ageTone(10 * MIN, late)).toBe("warn");
  expect(ageTone(10 * MIN + S, late)).toBe("late");
});
