import { randomBytes, scryptSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  assertHash,
  DUMMY_HASH,
  hashPin,
  hashSessionId,
  needsRehash,
  newSessionId,
  pinDerivations,
  sameSecret,
  verifyPin,
} from "../src/server/auth.ts";
import { createLimiter } from "../src/server/limits.ts";

describe("PINs", () => {
  test("are stored only as a salted PBKDF2-SHA256 hash, and verify", async () => {
    const hash = await hashPin("4821");
    expect(hash).toMatch(/^pbkdf2-sha256\$3000\$[\w-]+\$[\w-]+$/);
    expect(hash).not.toContain("4821");
    expect(await hashPin("4821")).not.toBe(hash);
    expect(await verifyPin("4821", hash)).toBe(true);
    expect(await verifyPin("4822", hash)).toBe(false);
    expect(await verifyPin("", hash)).toBe(false);
  });

  test("take a lower cost for tests, which verify reads back from the hash", async () => {
    const hash = await hashPin("4821", 1024);
    expect(hash).toMatch(/^pbkdf2-sha256\$1024\$/);
    expect(await verifyPin("4821", hash)).toBe(true);
    expect(await verifyPin("4822", hash)).toBe(false);
    await expect(hashPin("4821", 10)).rejects.toThrow("expected iterations from");
  });

  test("must be 4 to 12 digits", async () => {
    await expect(hashPin("12a4")).rejects.toThrow("expected a PIN of 4 to 12 digits");
    await expect(hashPin("123")).rejects.toThrow("expected a PIN of 4 to 12 digits");
  });

  test("a malformed hash is a setup mistake and fails loudly", async () => {
    await expect(verifyPin("4821", "plain-text-pin")).rejects.toThrow("from npm run hash-pin");
    expect(() => assertHash("pbkdf2-sha256$5$x$y", { legacy: true })).toThrow("another shape");
  });

  test("an older scrypt hash still verifies on Node, and is flagged for replacement", async () => {
    const salt = randomBytes(16);
    const key = scryptSync("4821", salt, 32, { N: 1024, r: 8, p: 1 });
    const old = `scrypt$1024$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
    expect(await verifyPin("4821", old)).toBe(true);
    expect(await verifyPin("4822", old)).toBe(false);
    expect(needsRehash(old)).toBe(true);
    expect(needsRehash(await hashPin("4821", 1024))).toBe(false);
    expect(() => assertHash(old, { legacy: true })).not.toThrow();
    expect(() => assertHash(old, { legacy: false })).toThrow("re-run npm run hash-pin");
  });

  test("checking a hash at boot derives nothing, and an unknown user costs one derivation, not two", async () => {
    const hash = await hashPin("4821", 1024);
    const before = pinDerivations();
    assertHash(hash, { legacy: false });
    expect(pinDerivations()).toBe(before);
    await verifyPin("00000000", DUMMY_HASH);
    expect(pinDerivations()).toBe(before + 1);
  });
});

test("session ids are random, and only their hash is kept", () => {
  const a = newSessionId();
  expect(a).not.toBe(newSessionId());
  expect(hashSessionId(a)).toBe(hashSessionId(a));
  expect(hashSessionId(a)).not.toContain(a);
  expect(sameSecret("abc", "abc")).toBe(true);
  expect(sameSecret("abc", "abd")).toBe(false);
  expect(sameSecret("abc", "abcd")).toBe(false);
});

test("the limiter allows max hits per window and then refuses until the window ends", () => {
  const limiter = createLimiter({ max: 2, windowMs: 1000 });
  expect(limiter.hit("ip", 0)).toBe(true);
  expect(limiter.blocked("ip", 0)).toBe(false);
  expect(limiter.hit("ip", 10)).toBe(true);
  expect(limiter.blocked("ip", 10)).toBe(true);
  expect(limiter.hit("ip", 20)).toBe(false);
  expect(limiter.hit("other", 20)).toBe(true);
  expect(limiter.hit("ip", 1000)).toBe(true);
  limiter.reset("ip");
  expect(limiter.blocked("ip", 1000)).toBe(false);
});
