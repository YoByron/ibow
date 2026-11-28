/** The running timer on an open card (D-105): time since ordering as text, and how late it reads. Pure. */

export type AgeTone = "fresh" | "warn" | "late";

const two = (n: number) => String(n).padStart(2, "0");

/** `m:ss` under an hour, then `h:mm`; a clock a little ahead of the order's reads 0:00, never a negative time. */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 3600) return `${Math.floor(s / 60)}:${two(s % 60)}`;
  return `${Math.floor(s / 3600)}:${two(Math.floor((s % 3600) / 60))}`;
}

/** Amber past half of the business's late time, red past it. */
export function ageTone(ms: number, lateMs: number): AgeTone {
  if (ms > lateMs) return "late";
  if (ms > lateMs / 2) return "warn";
  return "fresh";
}
