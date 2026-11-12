import { describe, expect, test, vi } from "vitest";
import { cashOptions, changeDue } from "../src/client/cash.ts";
import { memoryStore } from "../src/client/session.ts";
import { createVoice, type Utterance } from "../src/client/voice.ts";

/** A fake speechSynthesis: records what was spoken and finishes an utterance only when the test says so. */
function fakeSynth() {
  const spoken: { text: string; rate: number; lang: string }[] = [];
  let current: Utterance | undefined;
  return {
    spoken,
    synth: {
      speak(u: Utterance) {
        spoken.push({ text: u.text, rate: u.rate, lang: u.lang });
        current = u;
      },
      cancel() {
        current = undefined;
      },
    },
    finish() {
      const u = current;
      current = undefined;
      u?.onend?.();
    },
    fail() {
      const u = current;
      current = undefined;
      u?.onerror?.();
    },
  };
}

const utter = (text: string): Utterance => ({ text, lang: "", rate: 1, onend: null, onerror: null });

describe("voice", () => {
  test("speaks one utterance at a time, in order", () => {
    const f = fakeSynth();
    const voice = createVoice({ synth: () => f.synth, utter, storage: memoryStore(), lang: "en" });
    voice.say("Token 26-001");
    voice.say("Token 26-002");
    expect(f.spoken.map((s) => s.text)).toEqual(["Token 26-001"]);
    f.finish();
    expect(f.spoken.map((s) => s.text)).toEqual(["Token 26-001", "Token 26-002"]);
    f.fail();
    voice.say("Token 26-003");
    expect(f.spoken.map((s) => s.text)).toEqual(["Token 26-001", "Token 26-002", "Token 26-003"]);
    expect(f.spoken[0]?.lang).toBe("en");
  });

  test("moves on when an utterance never reports its end", () => {
    vi.useFakeTimers();
    try {
      const f = fakeSynth();
      const voice = createVoice({ synth: () => f.synth, utter, storage: memoryStore(), lang: "en" });
      voice.say("one");
      voice.say("two");
      vi.advanceTimersByTime(60_000);
      expect(f.spoken.map((s) => s.text)).toEqual(["one", "two"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("mute and rate are kept per device; muting stops and drops what was queued", () => {
    const storage = memoryStore();
    const f = fakeSynth();
    const voice = createVoice({ synth: () => f.synth, utter, storage, lang: "en" });
    voice.say("one");
    voice.say("two");
    voice.setMuted(true);
    voice.say("three");
    f.finish();
    expect(f.spoken.map((s) => s.text)).toEqual(["one"]);
    voice.setRate(1.4);
    voice.setRate(9);
    const again = createVoice({ synth: () => f.synth, utter, storage, lang: "en" });
    expect(again.muted()).toBe(true);
    expect(again.rate()).toBe(2);
    again.setMuted(false);
    again.say("four");
    expect(f.spoken.at(-1)).toEqual({ text: "four", rate: 2, lang: "en" });
  });

  test("does nothing, without failing, where the browser has no speech", () => {
    const voice = createVoice({ synth: () => undefined, utter, storage: memoryStore(), lang: "en" });
    expect(() => voice.say("Token 26-001")).not.toThrow();
    expect(voice.available()).toBe(false);
  });
});

describe("cash at the counter", () => {
  test("offers the exact amount, then the business's shortcuts that cover what is due", () => {
    expect(cashOptions(3000, "INR", [500, 1000, 2000, 3000, 4000, 5000])).toEqual([3000, 4000, 5000]);
    expect(cashOptions(2500, "INR", [500, 1000, 2000, 3000, 4000, 5000])).toEqual([2500, 3000, 4000, 5000]);
  });

  test("without shortcuts, or when none covers the amount, offers the next notes up in the currency", () => {
    expect(cashOptions(450, "USD")).toEqual([450, 500, 1000, 2000, 5000]);
    expect(cashOptions(780, "JPY")).toEqual([780, 1000, 2000, 5000, 10000]);
    expect(cashOptions(45000, "AED")).toEqual([45000, 50000, 100000, 200000, 500000]);
    expect(cashOptions(12000, "INR", [500, 1000, 5000])).toEqual([12000, 20000, 50000, 100000, 200000]);
    expect(cashOptions(1000, "USD")).toEqual([1000, 2000, 5000, 10000, 20000]);
  });

  test("change due is what was handed over minus what is owed; short is negative", () => {
    expect(changeDue(5000, 3000)).toBe(2000);
    expect(changeDue(3000, 3000)).toBe(0);
    expect(changeDue(2000, 3000)).toBe(-1000);
  });
});
