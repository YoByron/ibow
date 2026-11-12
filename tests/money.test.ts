import { describe, expect, test } from "vitest";
import { formatMoney, formatPrice, formatWhole, isCurrency, majorAmount, minorExponent } from "../src/core/money.ts";

describe("money", () => {
  test("knows each currency's minor-unit exponent", () => {
    expect(minorExponent("INR")).toBe(2);
    expect(minorExponent("USD")).toBe(2);
    expect(minorExponent("AED")).toBe(2);
    expect(minorExponent("JPY")).toBe(0);
    expect(minorExponent("KWD")).toBe(3);
  });

  test("accepts only ISO 4217 codes", () => {
    expect(isCurrency("AED")).toBe(true);
    expect(isCurrency("aed")).toBe(false);
    expect(isCurrency("XYZ")).toBe(false);
    expect(() => minorExponent("XYZ")).toThrow('minorExponent: expected an ISO 4217 currency code, found "XYZ"');
  });

  test("a plain major amount shows minor digits only when there are any", () => {
    expect(majorAmount(9000, "INR")).toBe("90");
    expect(majorAmount(9050, "INR")).toBe("90.50");
    expect(majorAmount(5, "USD")).toBe("0.05");
    expect(majorAmount(0, "AED")).toBe("0");
    expect(majorAmount(500, "JPY")).toBe("500");
    expect(majorAmount(1005, "KWD")).toBe("1.005");
  });

  test("refuses negative or fractional minor units", () => {
    expect(() => majorAmount(-500, "INR")).toThrow(
      "majorAmount: expected a non-negative integer amount in minor units, found -500",
    );
    expect(() => majorAmount(10.5, "INR")).toThrow("found 10.5");
    expect(() => majorAmount(Number.NaN, "INR")).toThrow("found NaN");
  });

  test("display formatting follows the currency, through Intl", () => {
    expect(formatMoney(9050, "USD", "en-US")).toBe("$90.50");
    expect(formatMoney(500, "JPY", "en-US")).toBe("¥500");
    expect(formatMoney(1500, "AED", "en-US")).toBe(
      new Intl.NumberFormat("en-US", { style: "currency", currency: "AED" }).format(15),
    );
    expect(formatMoney(9000, "INR", "en-IN")).toBe("₹90.00");
  });
});

describe("formatPrice", () => {
  test("drops the minor digits of a whole amount and keeps them otherwise, in INR, USD, JPY and KWD", () => {
    expect(formatPrice(2000, "INR", "en-US")).toBe("₹20");
    expect(formatPrice(4750, "INR", "en-US")).toBe("₹47.50");
    expect(formatPrice(300, "USD", "en-US")).toBe("$3");
    expect(formatPrice(375, "USD", "en-US")).toBe("$3.75");
    expect(formatPrice(500, "JPY", "en-US")).toBe("¥500");
    expect(formatPrice(3000, "KWD", "en-US").split(String.fromCharCode(160)).join(" ")).toBe("KWD 3");
    expect(formatPrice(3750, "KWD", "en-US").split(String.fromCharCode(160)).join(" ")).toBe("KWD 3.750");
    expect(formatPrice(0, "USD", "en-US")).toBe("$0");
    expect(formatPrice(-1500, "USD", "en-US")).toBe("-$15");
  });

  test("formatMoney keeps full precision for receipts and change", () => {
    expect(formatMoney(2000, "INR", "en-US")).toBe("₹20.00");
    expect(formatMoney(3000, "KWD", "en-US").split(String.fromCharCode(160)).join(" ")).toBe("KWD 3.000");
  });

  test("refuses a non-integer amount", () => {
    expect(() => formatPrice(1.5, "USD")).toThrow(/integer amount/);
  });
});

describe("formatWhole", () => {
  test("rounds an average to a whole amount, in the currency's own minor units", () => {
    expect(formatWhole(24038, "INR", "en-US")).toBe("₹240");
    expect(formatWhole(24050, "INR", "en-US")).toBe("₹241");
    expect(formatWhole(375, "USD", "en-US")).toBe("$4");
    expect(formatWhole(500, "JPY", "en-US")).toBe("¥500");
    expect(formatWhole(3750, "KWD", "en-US").replace(/\s/g, " ")).toBe("KWD 4");
  });
});
