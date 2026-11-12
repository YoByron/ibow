/**
 * What every page needs of the theme besides the stylesheet: the toggles, the logo, the labels and the two computed
 * storefront figures (from `/api/theme`), the dark-mode choice kept on this device, and the live refresh: when the
 * owner saves a new look, an open page swaps its stylesheet without a reload.
 */

import type { LabelOverrides } from "../../core/labels.ts";
import type { IconRef, Theme } from "../../core/theme.ts";
import { api } from "../api.ts";

export interface ThemeInfo {
  version: string;
  header: { style: "awning" | "plain" | "image" };
  logo?: IconRef;
  categoryIcons: Record<string, IconRef>;
  features: Theme["features"];
  strings: Record<string, LabelOverrides>;
  popular: Record<string, "bestseller" | "popular">;
  etaMinutes?: number;
}

/** Used when `/api/theme` can't be reached: the approved default look, with every toggle on. */
export const FALLBACK: ThemeInfo = {
  version: "",
  header: { style: "awning" },
  categoryIcons: {},
  features: { favourites: true, recent: true, tags: "catalog", veg: true, darkToggle: true, cartEta: false },
  strings: {},
  popular: {},
};

export async function loadThemeInfo(): Promise<ThemeInfo> {
  return api<ThemeInfo>("GET", "/api/theme").catch(() => FALLBACK);
}

const MODE_KEY = "ibow.mode";

function stored(): "light" | "dark" | undefined {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === "light" || v === "dark" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Applies the mode this device chose (the system's if none); call once at start. */
export function initMode(): void {
  const mode = stored();
  if (mode) document.documentElement.dataset.theme = mode;
}

export function isDark(): boolean {
  const set = document.documentElement.dataset.theme;
  return set ? set === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Flips light and dark and remembers it on this device. */
export function toggleMode(): boolean {
  const next = isDark() ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(MODE_KEY, next);
  } catch {
    // The choice just won't outlast this visit.
  }
  return next === "dark";
}

/** Points the page at a new theme sheet (the version in the query makes the browser and the worker refetch it). */
export function swapThemeSheet(version: string): void {
  const link = document.querySelector<HTMLLinkElement>('link[href^="/theme.css"]');
  if (link) link.href = `/theme.css?v=${encodeURIComponent(version)}`;
}

/**
 * Checks every `everyMs` for a new theme version and, when there is one, swaps the stylesheet (live) and tells the
 * page so it can redraw what the toggles change. Returns a stop function.
 */
export function watchTheme(info: ThemeInfo, onChange: (next: ThemeInfo) => void, everyMs = 30_000): () => void {
  let known = info.version;
  const check = async () => {
    const next = await api<ThemeInfo>("GET", "/api/theme").catch(() => undefined);
    if (next === undefined || next.version === known) return;
    known = next.version;
    swapThemeSheet(next.version);
    onChange(next);
  };
  const timer = setInterval(() => void check(), everyMs);
  const onVisible = () => {
    if (document.visibilityState === "visible") void check();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
