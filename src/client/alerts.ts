/**
 * Tells the customer their order moved: a short tone, a vibration and, if they allowed it, a notification. Each is
 * optional and silently skipped when the browser lacks it or the permission isn't granted.
 */

let audio: AudioContext | undefined;

/** Call from a tap (placing the order): browsers only let a page play sound after a user gesture. */
export function primeSound(): void {
  try {
    audio ??= new AudioContext();
    void audio.resume();
  } catch {
    audio = undefined;
  }
}

function tone(): void {
  if (audio === undefined || audio.state !== "running") return;
  const t = audio.currentTime;
  for (const [i, freq] of [880, 1320].entries()) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t + i * 0.18);
    gain.gain.exponentialRampToValueAtTime(0.3, t + i * 0.18 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.18 + 0.16);
    osc.connect(gain).connect(audio.destination);
    osc.start(t + i * 0.18);
    osc.stop(t + i * 0.18 + 0.17);
  }
}

export function canNotify(): boolean {
  return typeof Notification !== "undefined" && Notification.permission === "default";
}

export async function askToNotify(): Promise<boolean> {
  if (typeof Notification === "undefined") return false;
  try {
    return (await Notification.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

async function notify(title: string, body: string): Promise<void> {
  if (typeof Notification === "undefined" || Notification.permission !== "granted" || !document.hidden) return;
  try {
    // Android Chrome only shows notifications through the service worker.
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(title, { body, tag: "ibow-order" });
    else new Notification(title, { body, tag: "ibow-order" });
  } catch {
    // No notification is better than a broken page.
  }
}

export function announce(title: string, body: string): void {
  tone();
  try {
    navigator.vibrate?.([200, 100, 200]);
  } catch {
    // Some browsers throw without a recent tap.
  }
  void notify(title, body);
}
