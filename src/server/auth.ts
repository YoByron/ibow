/**
 * PIN hashing and session ids. Only hashes are stored; a PIN or session id never is. New hashes are PBKDF2-SHA256 through
 * WebCrypto (`pbkdf2-sha256$iterations$salt$key`, D-038), which a Cloudflare free-plan request can afford (10 ms of CPU);
 * hashes in the older scrypt format still verify on Node, and are replaced at the staff member's next good sign-in.
 */

import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/** Iterations of a new hash: about 3 ms in workerd (measured, D-038). The lockouts, not this, are what stops guessing. */
export const PIN_ITERATIONS = 3000;
const MIN_ITERATIONS = 1000;
const MAX_ITERATIONS = 10_000_000;
const KEY_BITS = 256;
const PIN = /^\d{4,12}$/;
const PBKDF2 = "pbkdf2-sha256";

let derivations = 0;
/** How many PIN derivations this process has run: a request path should cost at most one (it is the CPU budget). */
export function pinDerivations(): number {
  return derivations;
}

export interface ParsedHash {
  scheme: "pbkdf2-sha256" | "scrypt";
  /** Iterations (pbkdf2) or the scrypt cost N. */
  cost: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

const SHAPE = "pbkdf2-sha256$iterations$salt$key (or scrypt$N$r$p$salt$key) from npm run hash-pin";

/** Reads a stored hash without deriving anything; throws, saying what was expected, on any other shape. */
export function parseHash(hash: string): ParsedHash {
  const parts = hash.split("$");
  const bad = () => new Error(`verifyPin: expected a hash like ${SHAPE}, found another shape`);
  if (parts[0] === PBKDF2 && parts.length === 4) {
    const [, iterations, salt, key] = parts;
    const cost = Number(iterations);
    if (!salt || !key || !Number.isInteger(cost) || cost < MIN_ITERATIONS || cost > MAX_ITERATIONS) throw bad();
    return {
      scheme: PBKDF2,
      cost,
      r: 0,
      p: 0,
      salt: Buffer.from(salt, "base64url"),
      key: Buffer.from(key, "base64url"),
    };
  }
  if (parts[0] === "scrypt" && parts.length === 6) {
    const [, n, r, p, salt, key] = parts;
    if (!salt || !key) throw bad();
    return {
      scheme: "scrypt",
      cost: Number(n),
      r: Number(r),
      p: Number(p),
      salt: Buffer.from(salt, "base64url"),
      key: Buffer.from(key, "base64url"),
    };
  }
  throw bad();
}

/**
 * Checks a configured hash at boot without deriving it (a derivation costs request CPU). With `legacy: false` a hash in
 * the old scrypt format is refused, as on Workers, where it would not fit the CPU budget.
 */
export function assertHash(hash: string, opts: { legacy: boolean }): void {
  const parsed = parseHash(hash);
  if (parsed.scheme === "scrypt" && !opts.legacy) {
    throw new Error(
      "ibow: expected a pbkdf2-sha256 hash, found an older scrypt one; re-run npm run hash-pin and set the new hash",
    );
  }
}

/** Whether a stored hash is in the older format and should be replaced after a good sign-in. */
export function needsRehash(hash: string): boolean {
  return hash.startsWith("scrypt$");
}

async function pbkdf2(pin: string, salt: Buffer, iterations: number): Promise<Buffer> {
  derivations++;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: Uint8Array.from(salt), iterations },
    key,
    KEY_BITS,
  );
  return Buffer.from(bits);
}

function legacyScrypt(pin: string, p: ParsedHash): Promise<Buffer> {
  derivations++;
  return new Promise((resolve, reject) => {
    scrypt(pin, p.salt, p.key.length, { N: p.cost, r: p.r, p: p.p, maxmem: 256 * p.cost * p.r }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export function isPin(pin: unknown): pin is string {
  return typeof pin === "string" && PIN.test(pin);
}

/** `pbkdf2-sha256$iterations$<salt>$<hash>`, salt and hash base64url. `iterations` is for tests; keep the default otherwise. */
export async function hashPin(pin: string, iterations = PIN_ITERATIONS): Promise<string> {
  if (!isPin(pin)) throw new Error("hashPin: expected a PIN of 4 to 12 digits, found something else");
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    throw new Error(`hashPin: expected iterations from ${MIN_ITERATIONS} to ${MAX_ITERATIONS}, found ${iterations}`);
  }
  const salt = randomBytes(16);
  const key = await pbkdf2(pin, salt, iterations);
  return `${PBKDF2}$${iterations}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/**
 * A well-formed hash nobody has the PIN for, to check unknown users against, so a reply's timing doesn't reveal which
 * ids exist, at one derivation and not two (making one would cost another).
 */
export const DUMMY_HASH = `${PBKDF2}$${PIN_ITERATIONS}$${Buffer.alloc(16).toString("base64url")}$${Buffer.alloc(32).toString("base64url")}`;

/** Throws on a malformed hash (a setup mistake, which must be loud); false on a wrong PIN. */
export async function verifyPin(pin: string, hash: string): Promise<boolean> {
  const parsed = parseHash(hash);
  if (typeof pin !== "string" || !PIN.test(pin)) return false;
  const actual =
    parsed.scheme === PBKDF2 ? await pbkdf2(pin, parsed.salt, parsed.cost) : await legacyScrypt(pin, parsed);
  return actual.length === parsed.key.length && timingSafeEqual(actual, parsed.key);
}

/** A new random session id for the cookie, and the hash the store keeps. */
export function newSessionId(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionId(id: string): string {
  return createHash("sha256").update(id).digest("base64url");
}

/** Constant-time comparison of two secrets, for the customer's order key. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
