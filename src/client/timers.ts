/**
 * The running timer on every open card (D-105). A card carries `timer(createdAt)`; one interval per screen
 * (`startTimers`) rewrites each timer's text and tone in place every second, so nothing re-renders and focus stays put.
 */

import { ageTone, elapsedText } from "../core/elapsed.ts";
import { h } from "./dom.ts";

function paint(el: HTMLElement, now: number, lateMs: number): void {
  const ms = now - Number(el.dataset.since);
  const text = elapsedText(ms);
  if (el.textContent !== text) el.textContent = text;
  const tone = ageTone(ms, lateMs);
  if (el.dataset.tone !== tone) el.dataset.tone = tone;
}

/** A timer for an order taken at `createdAt`, drawn at once so a fresh card never shows a blank. */
export function timer(createdAt: number, now: number, lateMs: number): HTMLElement {
  const el = h("span", { class: "timer", role: "timer", "data-since": String(createdAt), "data-testid": "timer" });
  paint(el, now, lateMs);
  return el;
}

/** Ticks every timer under `root` once a second; returns the stop. */
export function startTimers(root: HTMLElement, now: () => number, lateMs: number): () => void {
  const tick = setInterval(() => {
    const at = now();
    for (const el of root.querySelectorAll<HTMLElement>(".timer[data-since]")) paint(el, at, lateMs);
  }, 1000);
  return () => clearInterval(tick);
}
