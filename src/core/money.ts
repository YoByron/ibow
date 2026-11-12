/** Money is an integer count of a currency's minor unit (cents, fils, paise; yen have none). Display goes through Intl. */

let known: Set<string> | undefined;

/** True for an ISO 4217 code this runtime knows, in upper case. */
export function isCurrency(code: string): boolean {
  known ??= new Set(Intl.supportedValuesOf("currency"));
  return known.has(code);
}

const exponents = new Map<string, number>();

/** Digits after the decimal point in the currency's major unit: 2 for USD, AED and INR, 0 for JPY, 3 for KWD. */
export function minorExponent(currency: string): number {
  let exp = exponents.get(currency);
  if (exp === undefined) {
    if (!isCurrency(currency)) {
      throw new Error(`minorExponent: expected an ISO 4217 currency code, found ${JSON.stringify(currency)}`);
    }
    exp = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
    exponents.set(currency, exp);
  }
  return exp;
}

function checkMinor(fn: string, minor: number): void {
  if (!Number.isSafeInteger(minor) || minor < 0) {
    throw new Error(`${fn}: expected a non-negative integer amount in minor units, found ${minor}`);
  }
}

/** A plain decimal in the major unit, for payment links: `90`, `90.50`, `500` (JPY). Minor digits only if non-zero. */
export function majorAmount(minor: number, currency: string): string {
  checkMinor("majorAmount", minor);
  const exp = minorExponent(currency);
  if (exp === 0) return String(minor);
  const unit = 10 ** exp;
  const rest = minor % unit;
  const whole = String(Math.trunc(minor / unit));
  return rest === 0 ? whole : `${whole}.${String(rest).padStart(exp, "0")}`;
}

/** The amount as people read it, in the given locale: `$90.50`, `¥500`, `₹90.00`. */
export function formatMoney(minor: number, currency: string, locale?: string): string {
  if (!Number.isSafeInteger(minor)) {
    throw new Error(`formatMoney: expected an integer amount in minor units, found ${minor}`);
  }
  const exp = minorExponent(currency);
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(minor / 10 ** exp);
}

/**
 * The amount for a screen: a whole amount without minor digits (`₹20`, `$3`, `KWD 3`), one that isn't with all of
 * them (`₹47.50`, `$3.75`, `KWD 3.750`). Receipts, tickets and the cash change keep `formatMoney`'s full precision.
 */
export function formatPrice(minor: number, currency: string, locale?: string): string {
  if (!Number.isSafeInteger(minor)) {
    throw new Error(`formatPrice: expected an integer amount in minor units, found ${minor}`);
  }
  const exp = minorExponent(currency);
  const whole = minor % 10 ** exp === 0;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    ...(whole ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {}),
  }).format(minor / 10 ** exp);
}

/** The amount rounded to a whole major unit (`₹240` for 240.38), for averages, where the minor digits are noise. */
export function formatWhole(minor: number, currency: string, locale?: string): string {
  if (!Number.isSafeInteger(minor)) {
    throw new Error(`formatWhole: expected an integer amount in minor units, found ${minor}`);
  }
  const unit = 10 ** minorExponent(currency);
  return formatPrice(Math.round(minor / unit) * unit, currency, locale);
}
