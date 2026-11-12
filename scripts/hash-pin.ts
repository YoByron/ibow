// Prints the PBKDF2-SHA256 hash of a PIN for OWNER_PIN_HASH:
//   node scripts/hash-pin.ts            (type the PIN, then Enter; a terminal shows nothing as you type)
//   echo 482915 | node scripts/hash-pin.ts   (piped input works too)
// The PIN is read from the terminal or stdin, never from the command line, so it stays out of shell history.
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { hashPin, isPin } from "../src/server/auth.ts";

export interface KeyState {
  pin: string;
  done: boolean;
  cancelled: boolean;
}

/** One typed character into the PIN: Enter (or a newline) finishes, backspace removes one, Ctrl+C cancels. */
export function feedKey(state: KeyState, key: string): KeyState {
  if (state.done || state.cancelled) return state;
  if (key === "\r" || key === "\n") return { ...state, done: true };
  if (key === "\u0003") return { ...state, cancelled: true };
  if (key === "\u007f" || key === "\u0008") return { ...state, pin: state.pin.slice(0, -1) };
  return { ...state, pin: state.pin + key };
}

/** Reads the PIN with no echo from a terminal. */
function readHidden(): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    let state: KeyState = { pin: "", done: false, cancelled: false };
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const key of chunk) state = feedKey(state, key);
      if (!state.done && !state.cancelled) return;
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
      process.stderr.write("\n");
      if (state.cancelled) reject(new Error("hash-pin: cancelled"));
      else resolve(state.pin.trim());
    };
    input.on("data", onData);
  });
}

async function readPiped(): Promise<string> {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const pin = ((await rl.question("")) ?? "").trim();
  rl.close();
  return pin;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stderr.write("PIN (4 to 12 digits, not shown as you type): ");
    const pin = process.stdin.isTTY ? await readHidden() : await readPiped();
    if (!isPin(pin)) {
      process.stderr.write("\nhash-pin: expected a PIN of 4 to 12 digits, found something else\n");
      process.exit(1);
    }
    process.stdout.write(`${await hashPin(pin)}\n`);
  } catch (e) {
    process.stderr.write(`\n${(e as Error).message}\n`);
    process.exit(1);
  }
}
