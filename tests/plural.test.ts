/** Counts in words (D-053): "1 order", never "1 orders", through the strings and Intl.PluralRules. */

import { describe, expect, test } from "vitest";
import { ownerEn, tn as ownerTn } from "../src/client/owner-strings.ts";
import { staffEn } from "../src/client/staff-strings.ts";
import { tn, useStrings } from "../src/client/strings.ts";
import { LABELS, parseStrings } from "../src/core/labels.ts";
import { pluralForm, pluralKey } from "../src/core/plural.ts";

describe("pluralKey", () => {
  const has = (k: string) => ["a_one", "a_few", "a_many"].includes(k);
  test("picks the form of the language's category, and the general text when the form is missing", () => {
    expect(pluralKey("a", 1, "en", has)).toBe("a_one");
    expect(pluralKey("a", 0, "en", has)).toBe("a");
    expect(pluralKey("a", 2, "en", has)).toBe("a");
    expect(pluralKey("b", 1, "en", has)).toBe("b");
    expect(pluralKey("a", 3, "pl", has)).toBe("a_few");
    expect(pluralKey("a", 5, "pl", has)).toBe("a_many");
    expect(pluralKey("a", 1, "not a locale!!", has)).toBe("a_one");
  });
  test("names a form by its key and category", () => {
    expect(pluralForm("itemsCount_one")).toEqual({ base: "itemsCount", category: "one" });
    expect(pluralForm("itemsCount")).toBeUndefined();
  });
});

describe("the owner's strings", () => {
  test("1 order, 2 orders: the dashboard's counts", () => {
    expect(ownerTn("awaitingCount", 1, { n: "1" })).toBe("1 order to match");
    expect(ownerTn("awaitingCount", 3, { n: "3" })).toBe("3 orders to match");
    expect(ownerTn("barLabel", 1, { hour: "9 AM", orders: "1" })).toBe("9 AM: 1 order");
    expect(ownerTn("returning", 1, { n: "1" })).toBe("Returning · 1 earlier visit");
    expect(ownerTn("returning", 4, { n: "4" })).toBe("Returning · 4 earlier visits");
    expect(ownerTn("reviewAverage", 1, { average: "5.0", count: "1" })).toBe("5.0 out of 5 from the latest review");
  });
});

describe("the customer's strings", () => {
  test("1 item, 1 size; an override replaces the forms with its own, never mixing in English ones", () => {
    useStrings({}, "en-US");
    expect(tn("itemsCount", 1, { n: "1" })).toBe("1 item");
    expect(tn("itemsCount", 12, { n: "12" })).toBe("12 items");
    expect(tn("sizesCount", 1, { n: "1" })).toBe("1 size");
    useStrings({ hi: { itemsCount: "{n} आइटम" } }, "hi-IN");
    expect(tn("itemsCount", 1, { n: "1" })).toBe("1 आइटम");
    useStrings(
      { pl: { itemsCount: "{n} pozycji", itemsCount_one: "{n} pozycja", itemsCount_few: "{n} pozycje" } },
      "pl",
    );
    expect(tn("itemsCount", 1, { n: "1" })).toBe("1 pozycja");
    expect(tn("itemsCount", 3, { n: "3" })).toBe("3 pozycje");
    expect(tn("itemsCount", 5, { n: "5" })).toBe("5 pozycji");
    useStrings({}, "en");
  });

  test("a strings file may carry forms: known keys only, any CLDR category, and a form needs no count in it", () => {
    expect(parseStrings({ itemsCount_one: "one item", itemsCount_few: "{n} few" }, "strings.pl.json")).toEqual({
      itemsCount_one: "one item",
      itemsCount_few: "{n} few",
    });
    expect(() => parseStrings({ nope_one: "x" }, "strings.pl.json")).toThrow(/known label key/);
    expect(() => parseStrings({ itemsCount_several: "x" }, "strings.pl.json")).toThrow(/known label key/);
    expect(() => parseStrings({ itemsCount: "no count" }, "strings.pl.json")).toThrow(/\{n\}/);
  });
});

describe("every count string is pluralised", () => {
  const COUNTED = /\{(?:n|orders|count|qty)\} (?:more |earlier )?(orders?|items?|sizes?|lines?|reviews?|visits?)\b/;
  const tables = { customer: LABELS, owner: ownerEn, staff: staffEn } as Record<string, Record<string, string>>;
  for (const [name, table] of Object.entries(tables)) {
    test(`${name}: a text that counts a noun has its one-form, and a one-form has its general text`, () => {
      const missing: string[] = [];
      for (const [key, text] of Object.entries(table)) {
        const form = pluralForm(key);
        if (form !== undefined) {
          expect(key in table && form.base in table, `${key} needs ${form.base}`).toBe(true);
        } else if (COUNTED.test(text) && !(`${key}_one` in table)) missing.push(key);
      }
      expect(missing, "counts of a noun with no _one form").toEqual([]);
    });
  }
});
