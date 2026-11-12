/**
 * The staff screens' voice: one queue, so call-outs never talk over each other, with a rate and a mute switch kept on
 * this device. Text comes from `strings.ts` and the core batch template; this module only speaks it.
 */

import type { KeyValue } from "./session.ts";

/** The part of `SpeechSynthesisUtterance` used here. */
export interface Utterance {
  text: string;
  lang: string;
  rate: number;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

/** The part of `speechSynthesis` used here. */
export interface Synth {
  speak(u: Utterance): void;
  cancel(): void;
}

export interface VoiceDeps {
  /** Read at each utterance, so a test can stub `speechSynthesis` after the page loads. */
  synth: () => Synth | undefined;
  utter: (text: string) => Utterance;
  storage: KeyValue;
  lang: string;
}

export interface Voice {
  say(text: string): void;
  available(): boolean;
  muted(): boolean;
  setMuted(muted: boolean): void;
  rate(): number;
  setRate(rate: number): void;
}

const MUTE = "ibow.voice.muted";
const RATE = "ibow.voice.rate";
const MIN_RATE = 0.5;
const MAX_RATE = 2;

/** Some engines (Chrome on Android among them) now and then never fire `end`; past this the queue moves on. */
function deadlineMs(text: string, rate: number): number {
  return 4000 + (text.length * 120) / rate;
}

export function createVoice(deps: VoiceDeps): Voice {
  const queue: string[] = [];
  let speaking = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let token = 0;
  const storedRate = Number(deps.storage.get(RATE));
  let rate = Number.isFinite(storedRate) && storedRate > 0 ? clamp(storedRate) : 1;
  let muted = deps.storage.get(MUTE) === "1";

  function clamp(r: number): number {
    return Math.min(MAX_RATE, Math.max(MIN_RATE, r));
  }

  function next(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    speaking = false;
    const text = queue.shift();
    const synth = deps.synth();
    if (text === undefined || synth === undefined || muted) return;
    speaking = true;
    const mine = ++token;
    const done = () => {
      if (mine === token && speaking) next();
    };
    const u = deps.utter(text);
    u.lang = deps.lang;
    u.rate = rate;
    u.onend = done;
    u.onerror = done;
    timer = setTimeout(done, deadlineMs(text, rate));
    try {
      synth.speak(u);
    } catch {
      done();
    }
  }

  return {
    say(text) {
      if (muted || text.trim() === "" || deps.synth() === undefined) return;
      queue.push(text);
      if (!speaking) next();
    },
    available: () => deps.synth() !== undefined,
    muted: () => muted,
    setMuted(value) {
      muted = value;
      deps.storage.set(MUTE, value ? "1" : "0");
      if (value) {
        queue.length = 0;
        token++;
        speaking = false;
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        deps.synth()?.cancel();
      }
    },
    rate: () => rate,
    setRate(value) {
      rate = clamp(value);
      deps.storage.set(RATE, String(rate));
    },
  };
}

/** The browser's own speech, or nothing where there is none. */
export function browserVoice(storage: KeyValue, lang: string): Voice {
  return createVoice({
    synth: () => (typeof speechSynthesis === "undefined" ? undefined : (speechSynthesis as unknown as Synth)),
    utter: (text) => new SpeechSynthesisUtterance(text) as unknown as Utterance,
    storage,
    lang,
  });
}
