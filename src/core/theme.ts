/**
 * The look of an install, as data (D-047): `theme.json` beside the business config, validated like the other files,
 * and the owner's Appearance override on top. Pure: it turns a theme into design tokens (CSS custom properties) and
 * checks contrast; it knows no business and reads no file. Every colour not named here is derived from the named ones.
 */

import { ConfigError } from "./config.ts";

/** The bundled icon set, drawn for ibow as line icons (`src/client/ui/icons.ts`), coloured by the theme (D-070). */
export const ICONS: readonly string[] = [
  "bank",
  "bar_chart",
  "bell",
  "bento_box",
  "beverage_box",
  "bubble_tea",
  "chart_increasing",
  "check_mark_button",
  "cheese_wedge",
  "chequered_flag",
  "clipboard",
  "cocktail_glass",
  "cake",
  "cooking",
  "counterclockwise_arrows_button",
  "credit_card",
  "crescent_moon",
  "croissant",
  "cup_with_straw",
  "dollar_banknote",
  "dumpling",
  "ear_of_corn",
  "face_savoring_food",
  "fire",
  "fork_and_knife_with_plate",
  "french_fries",
  "hamburger",
  "honey_pot",
  "hot_beverage",
  "hot_pepper",
  "hourglass_not_done",
  "ice",
  "leaf_fluttering_in_wind",
  "lemon",
  "locked",
  "map_pin",
  "magnifying_glass_tilted_left",
  "megaphone",
  "mobile_phone",
  "money_bag",
  "pancakes",
  "party_popper",
  "peach",
  "pot_of_food",
  "receipt",
  "salad",
  "sandwich",
  "shopping_cart",
  "spaghetti",
  "sparkles",
  "speaker_high_volume",
  "star",
  "steaming_bowl",
  "stopwatch",
  "sun",
  "takeout_box",
  "teacup_without_handle",
  "teapot",
  "thinking_face",
  "ticket",
  "tropical_drink",
  "watermelon",
  "wrapped_gift",
];

/** Bundled typefaces (all open licences, Latin subset, one variable file each) or the device's own. */
export const FONTS = ["inter", "fraunces", "lora", "nunito", "space-grotesk", "system"] as const;
export type FontId = (typeof FONTS)[number];
export const RADII = ["sharp", "soft", "round"] as const;
export type Radius = (typeof RADII)[number];
export const DENSITIES = ["comfortable", "compact"] as const;
export type Density = (typeof DENSITIES)[number];
export const HEADER_STYLES = ["awning", "plain", "image"] as const;
export type HeaderStyle = (typeof HEADER_STYLES)[number];
export const TAG_MODES = ["off", "catalog", "auto"] as const;
/** `always`: every item card has a picture (its photo, else a tinted tile with its icon). `photos`: only items with a photo do. */
export const TILE_MODES = ["always", "photos"] as const;
export type TileMode = (typeof TILE_MODES)[number];
export type TagMode = (typeof TAG_MODES)[number];

/** An icon from the bundled set, or an image: a file in the config folder or an https URL. */
export type IconRef = { icon: string } | { image: string };

export interface Theme {
  colors: {
    primary: string;
    accent: string;
    header: string;
    light: { surface: string; text: string };
    dark: { surface: string; text: string };
  };
  font: FontId;
  /** The face of headings, prices, the business name and the token; the body font when absent. */
  display?: FontId;
  radius: Radius;
  density: Density;
  header: { style: HeaderStyle; awning: [string, string]; image?: string };
  logo?: IconRef;
  categoryIcons: Record<string, IconRef>;
  features: {
    favourites: boolean;
    recent: boolean;
    tags: TagMode;
    veg: boolean;
    darkToggle: boolean;
    cartEta: boolean;
    tiles: TileMode;
    /** A "Most loved" strip at the top of the menu: the items with a photo, best sellers first. */
    featured: boolean;
  };
}

export const DEFAULT_THEME: Theme = {
  colors: {
    primary: "#2d5a27",
    accent: "#f5c518",
    header: "#1e3d1a",
    light: { surface: "#f5f5f5", text: "#151a14" },
    dark: { surface: "#121512", text: "#f4f6f2" },
  },
  font: "inter",
  radius: "round",
  density: "comfortable",
  header: { style: "awning", awning: ["#a8d24e", "#ffffff"] },
  categoryIcons: {},
  features: {
    favourites: true,
    recent: true,
    tags: "auto",
    veg: true,
    darkToggle: true,
    cartEta: true,
    tiles: "always",
    featured: false,
  },
};

const FILE_REF = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpg|jpeg|webp|svg)$/;
const HTTPS_REF = /^https:\/\/[^\s"'()<>\\]+$/;
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

// ── Validation ──────────────────────────────────────────────────────────────────────────────────────────────────────

function describe(v: unknown): string {
  if (v === undefined) return "nothing";
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return `${typeof v} ${String(v)}`;
  return `a ${typeof v}`;
}

function obj(file: string, v: unknown, field: string, allowed: readonly string[]): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new ConfigError(file, field, "an object", describe(v));
  }
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k)) {
      throw new ConfigError(file, field ? `${field}.${k}` : k, `one of ${allowed.join(", ")}`, "an unknown field");
    }
  }
  return v as Record<string, unknown>;
}

function pick<T extends string>(file: string, v: unknown, field: string, options: readonly T[]): T {
  if (typeof v !== "string" || !options.includes(v as T)) {
    throw new ConfigError(file, field, `one of ${options.join(", ")}`, describe(v));
  }
  return v as T;
}

function color(file: string, v: unknown, field: string): string {
  if (typeof v !== "string" || !HEX.test(v)) throw new ConfigError(file, field, "a colour like #2d5a27", describe(v));
  return normalHex(v);
}

function bool(file: string, v: unknown, field: string): boolean {
  if (typeof v !== "boolean") throw new ConfigError(file, field, "true or false", describe(v));
  return v;
}

/** A bundled icon name, a file in the config folder, or an https URL. */
export function parseIconRef(file: string, v: unknown, field: string): IconRef {
  if (typeof v === "string") {
    if (ICONS.includes(v)) return { icon: v };
    if (FILE_REF.test(v) || HTTPS_REF.test(v)) return { image: v };
  }
  throw new ConfigError(
    file,
    field,
    "a bundled icon name, an image file name (png, jpg, webp, svg) or an https URL",
    describe(v),
  );
}

/** An image: a file in the config folder or an https URL. Shared by theme and catalog photos. */
export function parseImageRef(file: string, v: unknown, field: string): string {
  if (typeof v === "string" && (FILE_REF.test(v) || HTTPS_REF.test(v))) return v;
  throw new ConfigError(file, field, "an image file name in the config folder or an https URL", describe(v));
}

/** Image references a theme names, for the content security policy and the existence check. */
export function themeImages(theme: Theme): string[] {
  const out: string[] = [];
  if (theme.header.image !== undefined) out.push(theme.header.image);
  if (theme.logo && "image" in theme.logo) out.push(theme.logo.image);
  for (const r of Object.values(theme.categoryIcons)) if ("image" in r) out.push(r.image);
  return out;
}

/**
 * Validates a theme document (a partial one: anything missing takes the default). Unknown fields are refused, so a
 * typo can't silently do nothing. Names the file, the field path, what was expected and what was found.
 */
export function parseTheme(raw: unknown, file = "theme.json"): Theme {
  const o = obj(file, raw, "", [
    "colors",
    "font",
    "display",
    "radius",
    "density",
    "header",
    "logo",
    "categoryIcons",
    "features",
  ]);
  const d = DEFAULT_THEME;
  const theme: Theme = {
    colors: structuredClone(d.colors),
    font: d.font,
    radius: d.radius,
    density: d.density,
    header: { ...d.header, awning: [...d.header.awning] },
    categoryIcons: {},
    features: { ...d.features },
  };
  if (o.colors !== undefined) {
    const c = obj(file, o.colors, "colors", ["primary", "accent", "header", "light", "dark"]);
    for (const k of ["primary", "accent", "header"] as const) {
      if (c[k] !== undefined) theme.colors[k] = color(file, c[k], `colors.${k}`);
    }
    for (const mode of ["light", "dark"] as const) {
      if (c[mode] === undefined) continue;
      const m = obj(file, c[mode], `colors.${mode}`, ["surface", "text"]);
      for (const k of ["surface", "text"] as const) {
        if (m[k] !== undefined) theme.colors[mode][k] = color(file, m[k], `colors.${mode}.${k}`);
      }
    }
  }
  if (o.font !== undefined) theme.font = pick(file, o.font, "font", FONTS);
  if (o.display !== undefined) theme.display = pick(file, o.display, "display", FONTS);
  if (o.radius !== undefined) theme.radius = pick(file, o.radius, "radius", RADII);
  if (o.density !== undefined) theme.density = pick(file, o.density, "density", DENSITIES);
  if (o.header !== undefined) {
    const h = obj(file, o.header, "header", ["style", "awning", "image"]);
    if (h.style !== undefined) theme.header.style = pick(file, h.style, "header.style", HEADER_STYLES);
    if (h.awning !== undefined) {
      if (!Array.isArray(h.awning) || h.awning.length !== 2) {
        throw new ConfigError(file, "header.awning", 'two colours, such as ["#a8d24e", "#ffffff"]', describe(h.awning));
      }
      theme.header.awning = [
        color(file, h.awning[0], "header.awning[0]"),
        color(file, h.awning[1], "header.awning[1]"),
      ];
    }
    if (h.image !== undefined) theme.header.image = parseImageRef(file, h.image, "header.image");
  }
  if (theme.header.style === "image" && theme.header.image === undefined) {
    throw new ConfigError(file, "header.image", 'an image when header.style is "image"', "nothing");
  }
  if (o.logo !== undefined) theme.logo = parseIconRef(file, o.logo, "logo");
  if (o.categoryIcons !== undefined) {
    const ci = obj(file, o.categoryIcons, "categoryIcons", Object.keys(o.categoryIcons as object));
    for (const [id, v] of Object.entries(ci)) theme.categoryIcons[id] = parseIconRef(file, v, `categoryIcons.${id}`);
  }
  if (o.features !== undefined) {
    const f = obj(file, o.features, "features", Object.keys(theme.features));
    for (const k of ["favourites", "recent", "veg", "darkToggle", "cartEta", "featured"] as const) {
      if (f[k] !== undefined) theme.features[k] = bool(file, f[k], `features.${k}`);
    }
    if (f.tags !== undefined) theme.features.tags = pick(file, f.tags, "features.tags", TAG_MODES);
    if (f.tiles !== undefined) theme.features.tiles = pick(file, f.tiles, "features.tiles", TILE_MODES);
  }
  return theme;
}

/**
 * The fields the Appearance screen may override (colours, font, radius, density, header style and awning, the logo,
 * toggles). Images stay with the config. The result is validated as a whole, like any theme.
 */
export const OVERRIDE_FIELDS = ["colors", "font", "radius", "density", "header", "logo", "features"] as const;

/** A resolved theme written back as a theme document, so an override can be merged into it and validated again. */
export function themeToRaw(theme: Theme): Record<string, unknown> {
  const ref = (r: IconRef) => ("icon" in r ? r.icon : r.image);
  const raw = structuredClone(theme) as unknown as Record<string, unknown>;
  if (theme.logo) raw.logo = ref(theme.logo);
  raw.categoryIcons = Object.fromEntries(Object.entries(theme.categoryIcons).map(([k, v]) => [k, ref(v)]));
  return raw;
}

export function applyOverride(base: Theme, override: unknown, file = "appearance"): Theme {
  const o = obj(file, override, "", OVERRIDE_FIELDS);
  if (o.header !== undefined) obj(file, o.header, "header", ["style", "awning"]);
  const merged = mergeDeep(themeToRaw(base), o);
  return parseTheme(merged, file);
}

function mergeDeep(into: Record<string, unknown>, from: Record<string, unknown>): Record<string, unknown> {
  for (const [k, v] of Object.entries(from)) {
    const cur = into[k];
    if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)) {
      mergeDeep(cur as Record<string, unknown>, v as Record<string, unknown>);
    } else into[k] = v;
  }
  return into;
}

// ── Colour maths ────────────────────────────────────────────────────────────────────────────────────────────────────

type Rgb = [number, number, number];

function normalHex(h: string): string {
  const s = h.toLowerCase();
  return s.length === 4 ? `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}` : s;
}

export function toRgb(hex: string): Rgb {
  const h = normalHex(hex);
  return [Number.parseInt(h.slice(1, 3), 16), Number.parseInt(h.slice(3, 5), 16), Number.parseInt(h.slice(5, 7), 16)];
}

export function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b]
    .map((n) =>
      Math.round(Math.min(255, Math.max(0, n)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** `t` of the way from `a` to `b`. */
export function mix(a: string, b: string, t: number): string {
  const x = toRgb(a);
  const y = toRgb(b);
  return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

function luminance(hex: string): number {
  const lin = toRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (lin[0] as number) + 0.7152 * (lin[1] as number) + 0.0722 * (lin[2] as number);
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = toRgb(hex).map((v) => v / 255) as Rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, sat, l];
}

function fromHsl(h: number, s: number, l: number): string {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return toHex([f(0) * 255, f(8) * 255, f(4) * 255]);
}

/**
 * `fg` with its lightness moved (hue and saturation kept, so a gold stays a gold) until it reads at `min` on every one
 * of the `on` surfaces: darker on light surfaces, lighter on dark ones. `floor` is the least lightness a lightened
 * colour may end at, so accents on a dark page stay bright rather than just passing. A colour that already reads is
 * left alone, unless it is lighter-needed and below the floor on a dark surface.
 */
export function readable(fg: string, on: string | readonly string[], min = 4.5, floor = 0): string {
  const surfaces = typeof on === "string" ? [on] : on;
  const reads = (c: string) => surfaces.every((bg) => contrast(c, bg) >= min);
  const light = surfaces.reduce((n, bg) => n + luminance(bg), 0) / surfaces.length > 0.4;
  const [h, sat, l] = toHsl(fg);
  if (reads(fg) && (light || l >= floor)) return fg;
  for (let step = 1; step <= 100; step++) {
    const next = light ? l - step / 100 : l + step / 100;
    if (next < 0 || next > 1) break;
    const c = fromHsl(h, sat, next);
    if (reads(c) && (light || next >= floor)) return c;
  }
  return light ? "#000000" : "#ffffff";
}

const INK = "#111611";
/** White or near-black, whichever reads better on `bg`. */
export function bestOn(bg: string): string {
  if (contrast(INK, bg) >= 4.5) return INK;
  return contrast("#ffffff", bg) >= 4.5 ? "#ffffff" : "#000000";
}

export interface ContrastCheck {
  /** What is checked, in words the owner reads. */
  pair: string;
  ratio: number;
  min: number;
  ok: boolean;
}

const cardOf = (surface: string, dark: boolean) => (dark ? mix(surface, "#ffffff", 0.05) : "#ffffff");

/** The pairs an owner's choices can break: text on its page in each mode, and the main colour against the light cards. */
export function checkContrast(theme: Theme): ContrastCheck[] {
  const c = theme.colors;
  const rows: [string, string, string, number][] = [
    ["Text on the page, light mode", c.light.text, c.light.surface, 4.5],
    ["Text on the page, dark mode", c.dark.text, c.dark.surface, 4.5],
    ["Buttons and steppers against the cards", c.primary, cardOf(c.light.surface, false), 3],
  ];
  return rows.map(([pair, a, b, min]) => {
    const ratio = Math.round(contrast(a, b) * 100) / 100;
    return { pair, ratio, min, ok: ratio >= min };
  });
}

// ── Tokens ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Item-tile tints (light, deep) cycled by category position; the dark mode derives its own. */
const TINTS: readonly (readonly [string, string])[] = [
  ["#f9e6c6", "#e8bf86"],
  ["#d9f0ee", "#a7d9d6"],
  ["#fde4c8", "#f7bd84"],
  ["#d9f1d2", "#a2d98f"],
  ["#fde7cd", "#f3b97c"],
  ["#f9e2cf", "#e8b48d"],
  ["#e0efd9", "#b3d8a4"],
];
export const TINT_COUNT = TINTS.length;

const RADIUS: Record<Radius, Record<string, string>> = {
  round: { pill: "999px", card: "20px", panel: "16px", ctl: "12px", sheet: "28px", img: "16px" },
  soft: { pill: "12px", card: "12px", panel: "10px", ctl: "8px", sheet: "16px", img: "10px" },
  sharp: { pill: "4px", card: "2px", panel: "2px", ctl: "2px", sheet: "0px", img: "0px" },
};
const SPACE: Record<Density, number[]> = {
  comfortable: [4, 8, 12, 16, 24],
  compact: [3, 6, 9, 12, 18],
};
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const SERIF = 'Georgia, "Times New Roman", serif';

export function fontStack(font: FontId): string {
  if (font === "system") return SANS;
  return `"ibow-${font}", ${font === "lora" || font === "fraunces" ? SERIF : SANS}`;
}

/** The custom properties of one mode (light or dark), derived from the theme. */
export function themeVars(theme: Theme, mode: "light" | "dark"): Record<string, string> {
  const dark = mode === "dark";
  const { primary, accent, header } = theme.colors;
  const { surface, text } = theme.colors[mode];
  const card = cardOf(surface, dark);
  const rgba = (hex: string, a: number) => {
    const [r, g, b] = toRgb(hex);
    return `rgba(${r},${g},${b},${a})`;
  };
  const shadow = (a: number) => (dark ? rgba("#000000", a + 0.25) : rgba(mix(header, "#000000", 0.5), a));
  // The tints text sits on, so each text token below is derived against the surfaces it is drawn on, not only the card.
  const card2 = mix(card, text, dark ? 0.06 : 0.045);
  const primarySoft = mix(primary, card, dark ? 0.78 : 0.88);
  const accentSoft = mix(accent, card, dark ? 0.86 : 0.8);
  const warnSoft = mix("#f59e0b", card, dark ? 0.85 : 0.82);
  const okSoft = mix("#22c55e", card, 0.85);
  const vars: Record<string, string> = {
    "--bg": surface,
    "--card": card,
    "--card-2": card2,
    "--ink": text,
    "--ink-2": mix(text, card, 0.2),
    "--ink-3": readable(mix(text, card, 0.5), [surface, card, card2], 4.5),
    "--line": rgba(text, dark ? 0.1 : 0.08),
    "--primary": primary,
    "--on-primary": bestOn(primary),
    "--primary-text": readable(primary, [surface, card, card2, primarySoft], 4.5, dark ? 0.7 : 0),
    "--primary-soft": primarySoft,
    "--accent": accent,
    "--on-accent": bestOn(accent),
    "--accent-text": readable(accent, [surface, card, card2, accentSoft], 4.5, dark ? 0.5 : 0),
    "--accent-soft": accentSoft,
    "--hdr-a": header,
    "--hdr-b": primary,
    "--on-hdr": bestOn(mix(header, primary, 0.5)),
    "--awn-a": theme.header.awning[0],
    "--awn-b": theme.header.awning[1],
    "--warn": "#f59e0b",
    "--warn-text": readable("#f59e0b", [surface, card, card2, warnSoft], 4.5, dark ? 0.65 : 0),
    "--warn-soft": warnSoft,
    "--ok": "#22c55e",
    "--ok-text": readable("#22c55e", [surface, card, card2, okSoft], 4.5, dark ? 0.67 : 0),
    "--ok-soft": okSoft,
    "--err": "#ef4444",
    "--scrim": "rgba(0,0,0,.5)",
    "--sh-1": `0 1px 2px ${shadow(0.06)}, 0 2px 8px ${shadow(0.05)}`,
    "--sh-2": `0 4px 16px ${shadow(0.1)}`,
    "--sh-3": `0 12px 32px ${shadow(0.18)}`,
    "color-scheme": mode,
  };
  TINTS.forEach(([a, b], i) => {
    vars[`--tint-${i}a`] = dark ? mix(a, card, 0.7) : a;
    vars[`--tint-${i}b`] = dark ? mix(b, card, 0.62) : b;
  });
  return vars;
}

/** Tokens that do not change with the mode: type, radius, spacing. */
export function baseVars(theme: Theme): Record<string, string> {
  const r = RADIUS[theme.radius];
  const vars: Record<string, string> = {
    "--font": fontStack(theme.font),
    "--font-display": fontStack(theme.display ?? theme.font),
    "--r-pill": r.pill as string,
    "--r-card": r.card as string,
    "--r-panel": r.panel as string,
    "--r-ctl": r.ctl as string,
    "--r-sheet": r.sheet as string,
    "--r-img": r.img as string,
    "--ctl-h": theme.density === "compact" ? "38px" : "44px",
    "--fs": theme.density === "compact" ? "13.5px" : "14px",
    "--ease": "cubic-bezier(.2,.8,.2,1)",
  };
  SPACE[theme.density].forEach((v, i) => {
    vars[`--sp-${i + 1}`] = `${v}px`;
  });
  return vars;
}

const decl = (vars: Record<string, string>) =>
  Object.entries(vars)
    .map(([k, v]) => `${k}:${v}`)
    .join(";");

/** The @font-face for the given bundled faces (the Appearance screen loads all four to preview them). */
export function fontFaces(fonts: readonly FontId[]): string {
  return fonts
    .filter((f) => f !== "system")
    .map(
      (f) =>
        `@font-face{font-family:"ibow-${f}";src:url(/assets/fonts/${f}.woff2) format("woff2");font-weight:100 900;font-display:swap}`,
    )
    .join("");
}

/** A string as a CSS string literal for `content:` (quotes and backslashes escaped, line breaks as spaces; never markup). */
export function cssString(text: string): string {
  return `"${text.replace(/[\\"]/g, (c) => `\\${c}`).replace(/[\n\r\f]/g, " ")}"`;
}

/**
 * `/theme.css`: the whole theme as custom properties, light, dark by the system or by `data-theme`, and the font. With
 * `brand`, also the business's name and image mark (`--brand-name`, `--brand-mark`), which the splash screen draws with
 * CSS alone, before any script has run (the policy allows no inline script or style).
 */
export function themeCss(theme: Theme, imageUrl: (ref: string) => string = (r) => r, brand?: { name: string }): string {
  const dark = decl(themeVars(theme, "dark"));
  const image = theme.header.image === undefined ? "" : `:root{--hdr-image:url("${imageUrl(theme.header.image)}")}`;
  const mark =
    theme.logo !== undefined && "image" in theme.logo
      ? `;--brand-mark:url("${imageUrl(theme.logo.image)}")`
      : ";--brand-mark-d:none";
  const named = brand === undefined ? "" : `:root{--brand-name:${cssString(brand.name)}${mark}}`;
  return (
    fontFaces([...new Set([theme.font, theme.display ?? theme.font])]) +
    `:root{${decl(baseVars(theme))};${decl(themeVars(theme, "light"))}}` +
    `@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${dark}}}` +
    `:root[data-theme=dark]{${dark}}` +
    image +
    named
  );
}
