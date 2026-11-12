/**
 * The number check on an analyst answer (D-027): a number is backed only by a figure cited in the same sentence, and
 * only in that figure's unit. Money compares in minor units of the currency, counts exactly, percentages with their
 * sign (written or said: "down 12%" is -12), hours by the hour ("6 PM" is 18:00), dates exactly. A figure may also back
 * the day, hour, clock time, span of days or item it is about (its `date`, `hour`, `at`, `days` and `item`). Nothing
 * is taken from keys, labels or `asOf`. Numbers written in words or in digits other than 0-9 can't be checked, so
 * they are flagged.
 */

import { minorExponent } from "../core/money.ts";
import type { AnalystContext, Answer, Figure } from "./analyst.ts";

type Token =
  | { kind: "date"; raw: string; date: string }
  | { kind: "time"; raw: string; hour: number; minute: number | undefined }
  | { kind: "percent"; raw: string; value: number; sign: -1 | 0 | 1 }
  | { kind: "number"; raw: string; text: string }
  | { kind: "unverifiable"; raw: string };

const CITATION = /\[([A-Za-z0-9_.:-]+)\]/g;
/** A sentence ends at . ! or ? and a space, unless a citation follows, which belongs to the sentence before. */
const SENTENCE_END = /(?<=[.!?])\s+(?!\[)/;
const TOKEN = new RegExp(
  [
    String.raw`(?<date>\b\d{4}-\d{2}-\d{2}\b)`,
    String.raw`(?<ampm>\b\d{1,2}(?::\d{2})?\s*[ap]\.?m\b\.?)`,
    String.raw`(?<clock>\b\d{1,2}:\d{2}\b)`,
    String.raw`(?<pct>[+\-−]?\d+(?:[.,]\d+)*\s*(?:%|per\s?cent\b))`,
    String.raw`(?<num>\d+(?:[.,]\d+)*)`,
  ].join("|"),
  "giu",
);
const GROUPED = /^\d{1,3}(?:,\d{2,3})+(?:\.\d+)?$/;
const WORDS =
  /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|lakh|crore|dozen|half|twice|double|triple)\b/giu;
/** Digits of any script but 0-9 (Devanagari, Arabic-Indic, …). */
const OTHER_DIGITS = /[^\P{Nd}0-9]+/gu;
const DOWN = /^(?:down|fell|fall|falls|dropped|drop|lower|less|fewer|decrease|decreased|declined|below|minus)$/i;
const UP = /^(?:up|rose|rise|rises|grew|higher|more|increase|increased|above|plus)$/i;

/** The direction words around a percentage say its sign: the nearest of the 4 words before, else the 2 after. */
function saidSign(before: string, after: string): -1 | 0 | 1 {
  const words = (s: string) => s.split(/[^\p{L}]+/u).filter((w) => w !== "");
  for (const w of words(before).slice(-4).reverse()) {
    if (DOWN.test(w)) return -1;
    if (UP.test(w)) return 1;
  }
  for (const w of words(after).slice(0, 2)) {
    if (DOWN.test(w)) return -1;
    if (UP.test(w)) return 1;
  }
  return 0;
}

function tokens(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const raw = m[0];
    const g = m.groups ?? {};
    if (g.date) out.push({ kind: "date", raw, date: raw });
    else if (g.ampm) {
      const [, h, min, half] = /^(\d{1,2})(?::(\d{2}))?\s*([ap])/i.exec(raw) as RegExpExecArray;
      const hour = (Number(h) % 12) + ((half as string).toLowerCase() === "p" ? 12 : 0);
      out.push({
        kind: "time",
        raw: raw.replace(/\.$/, ""),
        hour,
        minute: min === undefined ? undefined : Number(min),
      });
    } else if (g.clock) {
      const [h, min] = raw.split(":").map(Number) as [number, number];
      out.push({ kind: "time", raw, hour: h, minute: min });
    } else if (g.pct) {
      const explicit = /^[-−]/.test(raw) ? -1 : raw.startsWith("+") ? 1 : 0;
      const at = m.index ?? 0;
      const sign = explicit !== 0 ? explicit : saidSign(text.slice(0, at), text.slice(at + raw.length));
      out.push({ kind: "percent", raw, value: Number(/\d+(?:\.\d+)?/.exec(raw.replace(",", "."))?.[0]), sign });
    } else {
      const parts = GROUPED.test(raw) ? [raw.replace(/,/g, "")] : raw.split(",");
      for (const p of parts) out.push({ kind: "number", raw: parts.length > 1 ? p : raw, text: p });
    }
  }
  for (const [raw] of text.matchAll(WORDS)) out.push({ kind: "unverifiable", raw });
  for (const [raw] of text.matchAll(OTHER_DIGITS)) out.push({ kind: "unverifiable", raw });
  return out;
}

/** `text` (digits with an optional decimal point) in minor units of a currency with `exp` decimals, or undefined. */
function minor(text: string, exp: number): number | undefined {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (m === null) return undefined;
  const frac = m[2] ?? "";
  if (frac.length > exp) return undefined;
  return Number(m[1]) * 10 ** exp + Number(frac.padEnd(exp, "0") || "0");
}

const hourOf = (value: string) => Number(value.split(":")[0]);

function backs(f: Figure, t: Token, exp: number): boolean {
  switch (t.kind) {
    case "unverifiable":
      return false;
    case "date":
      return f.date === t.date || (f.unit === "date" && f.value.split(/,\s*/).includes(t.date));
    case "time": {
      const onTheHour = t.minute === undefined || t.minute === 0 || t.minute === 59;
      if (f.unit === "hour" && onTheHour && hourOf(f.value) === t.hour) return true;
      if (f.hour !== undefined && onTheHour && f.hour === t.hour) return true;
      return (
        f.at !== undefined &&
        t.minute !== undefined &&
        f.at === `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`
      );
    }
    case "percent": {
      if (f.unit !== "percent") return false;
      const v = Number(f.value);
      if (t.sign === 0) return v >= 0 && t.value === v;
      return t.sign * t.value === v;
    }
    case "number": {
      const isInteger = /^\d+$/.test(t.text);
      if (f.unit === "money") {
        const a = minor(t.text, exp);
        return a !== undefined && a === minor(f.value, exp);
      }
      if ((f.unit === "orders" || f.unit === "units") && isInteger && Number(t.text) === Number(f.value)) return true;
      if (f.unit === "hour" && isInteger && Number(t.text) === hourOf(f.value)) return true;
      if (isInteger && (f.days === Number(t.text) || f.hour === Number(t.text))) return true;
      return false;
    }
  }
}

/** Which figures `text` cites, and every number or citation in it that a figure cited beside it doesn't back. */
export function checkAnswer(text: string, ctx: AnalystContext): Answer {
  const byKey = new Map(ctx.figures.map((f) => [f.key, f]));
  const exp = minorExponent(ctx.currency);
  const figures: Figure[] = [];
  const unverified = new Set<string>();
  for (const sentence of text.split(SENTENCE_END)) {
    const cited: Figure[] = [];
    for (const [, key] of sentence.matchAll(CITATION)) {
      const f = byKey.get(key as string);
      if (f === undefined) unverified.add(`[${key}]`);
      else {
        if (!cited.includes(f)) cited.push(f);
        if (!figures.includes(f)) figures.push(f);
      }
    }
    let body = sentence.replace(CITATION, " ");
    // An item's own name may hold digits (a size such as 500ml); they are part of the name, not a number to check.
    for (const f of cited) if (f.item) body = body.split(f.item).join(" ");
    for (const t of tokens(body)) if (!cited.some((f) => backs(f, t, exp))) unverified.add(t.raw);
  }
  return { text, figures, unverified: [...unverified], grounded: unverified.size === 0 };
}
