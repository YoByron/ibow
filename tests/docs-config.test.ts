/** The worked example in docs/configure.md is real: its files load, and they describe a consistent business. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { loadConfig, parseBusiness, parseCatalog } from "../src/core/config.ts";
import { parseTheme } from "../src/core/theme.ts";

const doc = readFileSync(fileURLToPath(new URL("../docs/configure.md", import.meta.url)), "utf8");

/** The fenced blocks written as ```json config/<file>, by file name. */
function files(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of doc.matchAll(/```json (config\/[\w.-]+)\n([\s\S]*?)\n```/g)) {
    out[m[1] as string] = JSON.parse(m[2] as string);
  }
  return out;
}

test("the café example in the configure guide loads as a business, catalog and stations", () => {
  const f = files();
  expect(Object.keys(f).sort()).toEqual([
    "config/business.json",
    "config/catalog.json",
    "config/stations.json",
    "config/theme.json",
  ]);
  const config = loadConfig({
    business: f["config/business.json"],
    catalog: f["config/catalog.json"],
    stations: f["config/stations.json"],
  });
  expect(config.business).toMatchObject({ name: "Mill Lane Café", currency: "EUR", timeZone: "Europe/Lisbon" });
  expect(config.items.size).toBe(4);
  expect(parseTheme(f["config/theme.json"]).font).toBe("lora");
});

test("the full theme in the guide is valid and equals the defaults it claims to show", () => {
  const m = /## theme\.json[\s\S]*?```json\n([\s\S]*?)\n```/.exec(doc);
  const theme = parseTheme(JSON.parse(m?.[1] as string));
  expect(theme.colors.primary).toBe("#2d5a27");
  expect(theme.features.tags).toBe("auto");
  expect(theme.categoryIcons["hot-drinks"]).toEqual({ icon: "teapot" });
});

test("the business and catalog snippets in the guide are valid too", () => {
  const blocks = [...doc.matchAll(/```json\n([\s\S]*?)\n```/g)].map((b) => JSON.parse(b[1] as string));
  const business = blocks.find((b) => b.timeZone === "Asia/Kolkata");
  const catalog = blocks.find((b) => b.categories?.[0]?.id === "hot-drinks");
  expect(parseBusiness(business).retentionDays).toBe(30);
  expect(parseCatalog(catalog).categories[0]?.items).toHaveLength(2);
});

test("the starter config/ in the repo loads, so a fresh clone deploys and starts", () => {
  const read = (f: string) =>
    JSON.parse(readFileSync(fileURLToPath(new URL(`../config/${f}`, import.meta.url)), "utf8")) as unknown;
  const config = loadConfig({
    business: read("business.json"),
    catalog: read("catalog.json"),
    stations: read("stations.json"),
  });
  expect(config.stations.length).toBeGreaterThan(0);
});
