/**
 * The customer strings: the core defaults (`src/core/labels.ts`) with this install's overrides for the browser's
 * language on top (`strings.<locale>.json`, sent with the theme). Money is formatted by `formatMoney`.
 */

import { LABELS, type LabelKey, type LabelOverrides } from "../core/labels.ts";
import { type Pluralised, pluralKey } from "../core/plural.ts";

export const lang = "en";
export const en = LABELS;
export type StringKey = LabelKey;

let overrides: Readonly<LabelOverrides> = {};
let locale = "en";

/** Installs the overrides for `language` (such as `hi-IN`) from the locales the server sent: the full tag, then its base. */
export function useStrings(all: Readonly<Record<string, LabelOverrides>>, language: string): void {
  const tag = language.toLowerCase();
  const found =
    Object.entries(all).find(([k]) => k.toLowerCase() === tag) ??
    Object.entries(all).find(([k]) => k.toLowerCase() === tag.split("-")[0]);
  overrides = found?.[1] ?? {};
  locale = language;
}

/** The string for `key` with `{placeholders}` filled; an unknown placeholder stays visible rather than vanishing. */
export function t(key: StringKey, vars: Readonly<Record<string, string>> = {}): string {
  return (overrides[key] ?? LABELS[key]).replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole);
}

/**
 * The string for `key` in the form its `count` takes in the browser's language ("1 item", "3 items"). When an override
 * supplies the general text its forms come from the override alone, so a translation never shows an English form.
 */
export function tn(key: Pluralised<typeof LABELS>, count: number, vars: Readonly<Record<string, string>> = {}): string {
  const own = overrides[key] !== undefined;
  const has = (k: string) => (own ? k in overrides : k in LABELS);
  return t(pluralKey(key, count, locale, has) as StringKey, vars);
}
