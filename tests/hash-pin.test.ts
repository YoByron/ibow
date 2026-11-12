/** `npm run hash-pin`: the PIN is never echoed on a terminal, and still works piped. */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { feedKey } from "../scripts/hash-pin.ts";
import { verifyPin } from "../src/server/auth.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const run = (input: string) =>
  spawnSync(process.execPath, ["scripts/hash-pin.ts"], { cwd: root, input, encoding: "utf8" });

test("piped input prints a hash that verifies, with nothing but the hash on stdout and no echo of the PIN", async () => {
  const res = run("482915\n");
  expect(res.status).toBe(0);
  const hash = res.stdout.trim();
  expect(hash.split("\n")).toHaveLength(1);
  expect(await verifyPin("482915", hash)).toBe(true);
  expect(res.stdout + res.stderr).not.toContain("482915");
});

test("a bad PIN is refused with a message and no hash", () => {
  const res = run("12\n");
  expect(res.status).toBe(1);
  expect(res.stdout).toBe("");
  expect(res.stderr).toContain("expected a PIN of 4 to 12 digits");
});

test("typing on a terminal: keys build the PIN, backspace removes one, Enter finishes, Ctrl+C cancels, nothing is echoed", () => {
  const type = (keys: string) => {
    let state = { pin: "", done: false, cancelled: false };
    for (const k of keys) state = feedKey(state, k);
    return state;
  };
  expect(type("48\u007f215\r")).toEqual({ pin: "4215", done: true, cancelled: false });
  expect(type("12\u0008\u0008\u0008\r").pin).toBe("");
  expect(type("12\u0003").cancelled).toBe(true);
  expect(type("12\n34").pin).toBe("12");
});
