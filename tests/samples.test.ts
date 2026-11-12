import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { BATCH_TEMPLATES, type BatchTemplate, openBatch, renderBatch } from "../src/core/batches.ts";
import { stationFor } from "../src/core/config.ts";
import { createOrder, type Order } from "../src/core/orders.ts";
import { nextToken, type TokenCounter } from "../src/core/tokens.ts";
import { generateRush, type Rush, SAMPLE_RUSHES } from "./support/rush.ts";
import { loadSample, readSample, sampleRaw } from "./support/samples.ts";

const samples = readdirSync(fileURLToPath(new URL("../samples/", import.meta.url)), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
const en = BATCH_TEMPLATES.en as BatchTemplate;

test("the samples cover different kinds of business", () => {
  expect(samples).toEqual(["bakery", "coffee-cart", "food-truck", "service-desk", "tea-house"]);
});

test("the samples span more than one currency and time zone", () => {
  const businesses = samples.map((s) => loadSample(s).business);
  expect(new Set(businesses.map((b) => b.currency)).size).toBeGreaterThan(1);
  expect(new Set(businesses.map((b) => b.timeZone)).size).toBeGreaterThan(1);
});

describe.each(samples)("sample %s", (sample) => {
  const config = loadSample(sample);
  const rush = readSample(sample, "rush.json") as Rush;

  function replay(): Order[] {
    let counter: TokenCounter | null = null;
    return rush.orders.map((r, i) => {
      const next = nextToken(counter, r.at, config.business.timeZone);
      counter = next.counter;
      return createOrder(config, { id: `${sample}-${i}`, token: next.token, now: r.at, lines: r.lines });
    });
  }

  test("holds no real business details", () => {
    const business = sampleRaw(sample).business as Record<string, unknown>;
    expect(business.phone).toMatch(/^\+\d{1,3}( 0+)+$/);
    expect(business.address).toMatch(/^Example/);
  });

  test("routes every item to exactly one station", () => {
    expect(config.items.size).toBeGreaterThan(0);
    for (const [id, { categoryId }] of config.items) {
      const owners = config.stations.filter((s) => s.categories.includes(categoryId));
      expect(owners, id).toHaveLength(1);
      expect(stationFor(config, id), id).toBe(owners[0]);
    }
  });

  test("its rush is exactly what the seeded generator produces", () => {
    const opts = SAMPLE_RUSHES[sample];
    expect(opts, `SAMPLE_RUSHES["${sample}"]`).toBeDefined();
    if (opts) expect(rush).toEqual(generateRush(config.catalog, opts));
  });

  test("replays its rush with unique tokens", () => {
    const tokens = replay().map((o) => o.token);
    expect(tokens).toHaveLength(rush.orders.length);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  test("splits the rush across its stations and renders each batch", () => {
    const orders = replay();
    const ordered = orders.flatMap((o) => o.lines).reduce((s, l) => s + l.qty, 0);
    let batched = 0;
    for (const station of config.stations) {
      const batch = openBatch(orders, station.id);
      batched += batch.lines.reduce((s, l) => s + l.qty, 0);
      const text = renderBatch(batch, en);
      if (batch.lines.length === 0) {
        expect(text).toBe(en.empty);
        continue;
      }
      expect(text.startsWith(`Tokens ${batch.tokens.join(", ")} `), station.id).toBe(true);
      for (const line of batch.lines) expect(text, station.id).toContain(`${line.qty} ${line.name}`);
    }
    expect(batched).toBe(ordered);
  });
});
