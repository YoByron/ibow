/**
 * Plural forms of a string (D-053). A string table holds the general text under `key` and the other forms beside it as
 * `key_one`, `key_few` and so on, named after the CLDR plural categories that `Intl.PluralRules` selects for a count in
 * a language. English has `one` and the general text; Arabic or Polish may add `two`, `few`, `many` or `zero`. A form a
 * translation leaves out falls back to the general text, so a missing form is never a missing sentence.
 */

export const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many"] as const;

const rules = new Map<string, Intl.PluralRules>();

/** The CLDR category of `count` in `locale` (`other` is the general text). An unknown locale counts as English. */
export function pluralCategory(count: number, locale: string): Intl.LDMLPluralRule {
  let r = rules.get(locale);
  if (r === undefined) {
    try {
      r = new Intl.PluralRules(locale);
    } catch {
      r = new Intl.PluralRules("en");
    }
    rules.set(locale, r);
  }
  return r.select(count);
}

/** The key to read for `count`: `<key>_<category>` when `has` finds it, otherwise `key` itself. */
export function pluralKey(key: string, count: number, locale: string, has: (key: string) => boolean): string {
  const category = pluralCategory(count, locale);
  const form = `${key}_${category}`;
  return category !== "other" && has(form) ? form : key;
}

/** Splits `itemsCount_one` into its key and category; undefined for a key that is not a plural form. */
export function pluralForm(key: string): { base: string; category: string } | undefined {
  const m = /^(.+)_(zero|one|two|few|many)$/.exec(key);
  return m === null ? undefined : { base: m[1] as string, category: m[2] as string };
}

/** The keys of a table that have a `_one` form: the ones to read with a count. */
export type Pluralised<T> = { [K in keyof T]: K extends `${infer B}_one` ? B : never }[keyof T];
