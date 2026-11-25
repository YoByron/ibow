/**
 * The key in a room's QR (D-082). Only someone who scanned the code in that room may put an order on its bill: the
 * storefront sends the key from the QR (`/?spot=rooms-3&key=…`) with `pay: "room"`, and the server checks it. A key is an
 * HMAC-SHA256 of the spot id and the room's key number under a secret made once per install, both kept in the store's
 * `meta` (no table of keys), so it can't be guessed from the room's number, differs between installs, and is the same
 * every time the owner prints. "New QR" on the owner's Spots page bumps one room's number, so the old QR (a photo a
 * guest kept after checking out) stops working at once and every other room keeps its own.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store } from "../store/store.ts";

const SECRET = "room_key_secret";
/** One `meta` row per room that was ever given a new QR; a room without one is at number 0. */
const NUMBER = (spotId: string) => `room_key_number:${spotId}`;
/** 22 base64url characters: 132 bits, far past guessing at the order rate limit. */
const KEY_CHARS = 22;
const KEY_SHAPE = /^[A-Za-z0-9_-]{22}$/;

export interface RoomKeys {
  /** The key printed in this room's QR. */
  keyFor(spotId: string): string;
  /** Whether `key` is this room's, compared in constant time. */
  check(spotId: string, key: unknown): boolean;
  /** Gives the room a new key; the old one stops working. Returns the new key. */
  rotate(spotId: string): string;
}

export function roomKeys(store: Store): RoomKeys {
  let secret: string | undefined;
  const get = (): string => {
    // Read when first needed, so two holders in one process share the one secret, whichever made it.
    secret ??= store.meta(SECRET);
    if (secret === undefined) {
      secret = randomBytes(32).toString("base64url");
      store.setMeta(SECRET, secret);
    }
    return secret;
  };
  // Read each time, not cached: another holder (the Rooms routes make their own) may have rotated it.
  const number = (spotId: string) => Number(store.meta(NUMBER(spotId)) ?? "0");
  const keyFor = (spotId: string) => {
    const n = number(spotId);
    // Number 0 signs what every key signed before rotation existed, so printed QRs keep working.
    const message = n === 0 ? `room:${spotId}` : `room:${spotId}:${n}`;
    return createHmac("sha256", get()).update(message).digest("base64url").slice(0, KEY_CHARS);
  };
  return {
    keyFor,
    check(spotId, key) {
      // The shape first: `timingSafeEqual` compares bytes and throws on unequal lengths, so a key of 22 characters
      // that aren't all ASCII ("é" is two bytes) would be a 500, not a refusal.
      if (typeof key !== "string" || !KEY_SHAPE.test(key)) return false;
      return timingSafeEqual(Buffer.from(key), Buffer.from(keyFor(spotId)));
    },
    rotate(spotId) {
      store.setMeta(NUMBER(spotId), String(number(spotId) + 1));
      return keyFor(spotId);
    },
  };
}
