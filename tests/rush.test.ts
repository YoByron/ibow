import { describe, expect, test } from "vitest";
import { BATCH_TEMPLATES, type BatchTemplate, openBatch, renderBatch } from "../src/core/batches.ts";
import { createOrder, type Order } from "../src/core/orders.ts";
import { nextToken, type TokenCounter } from "../src/core/tokens.ts";
import { generateRush, type Rush, type RushOptions, SAMPLE_RUSHES } from "./support/rush.ts";
import { loadSample, readSample } from "./support/samples.ts";

const config = loadSample("tea-house");
const rush = readSample("tea-house", "rush.json") as Rush;

function replay(): Order[] {
  let counter: TokenCounter | null = null;
  return rush.orders.map((r, i) => {
    const next = nextToken(counter, r.at, config.business.timeZone);
    counter = next.counter;
    return createOrder(config, { id: `rush-${i}`, token: next.token, now: r.at, lines: r.lines });
  });
}

describe("300-order rush", () => {
  test("the fixture is exactly what the seeded generator produces", () => {
    expect(rush).toEqual(generateRush(config.catalog, SAMPLE_RUSHES["tea-house"] as RushOptions));
  });

  test("is 300 orders over two hours, in time order, with no customer names", () => {
    expect(rush.orders).toHaveLength(300);
    const times = rush.orders.map((o) => o.at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times[0]).toBeGreaterThanOrEqual(rush.start);
    expect(times.at(-1)).toBeLessThan(rush.start + 2 * 60 * 60_000);
    expect(JSON.stringify(rush)).not.toMatch(/name/i);
  });

  test("yields 300 unique tokens", () => {
    const tokens = replay().map((o) => o.token);
    expect(new Set(tokens).size).toBe(300);
    expect(tokens[0]).toBe("26-001");
    expect(tokens.at(-1)).toBe("26-300");
  });

  test("every item lands on exactly one station, and the batches split the rush between them", () => {
    const orders = replay();
    const lines = orders.flatMap((o) => o.lines);
    const tea = openBatch(orders, "tea");
    const kitchen = openBatch(orders, "kitchen");
    const total = (b: typeof tea) => b.lines.reduce((s, l) => s + l.qty, 0);
    expect(total(tea) + total(kitchen)).toBe(lines.reduce((s, l) => s + l.qty, 0));
    expect(total(tea)).toBeGreaterThan(0);
    expect(total(kitchen)).toBeGreaterThan(0);
    const text = renderBatch(tea, BATCH_TEMPLATES.en as BatchTemplate);
    expect(text).toMatch(/^Tokens 26-\d{3}(, 26-\d{3})* \d+ [A-Za-z][^,]*( [SML])?(, \d+ [A-Za-z][^,]*)*$/);
  });
});
