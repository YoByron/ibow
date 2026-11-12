/**
 * The look of an install over HTTP (D-047, D-049): `/theme.css` (the tokens, cached by build and theme version),
 * `/api/theme` (what the pages need besides CSS: toggles, logo, labels, the two computed storefront figures), the
 * owner's Appearance routes, and `/media/<file>` for the images the config names. The theme itself is pure
 * (`src/core/theme.ts`); this file holds the look in force and the owner's override from the store. It reads no files:
 * `look.ts` loads the config folder on Node, and a Worker gets the same look from a bundle made at deploy time (D-052).
 */

import { createHash } from "node:crypto";
import type { Context, Hono } from "hono";
import { type Catalog, ConfigError } from "../core/config.ts";
import type { LabelOverrides } from "../core/labels.ts";
import { popularTags, typicalWaitMinutes } from "../core/storefront.ts";
import { applyOverride, checkContrast, type Theme, themeCss } from "../core/theme.ts";
import type { Store } from "../store/store.ts";
import { ApiError, type Env } from "./errors.ts";

const DAY_MS = 86_400_000;
const FIGURES_MS = 30 * 60_000;

export interface Media {
  body: Uint8Array;
  type: string;
}

/** What the config folder holds beyond the three files: the theme, strings per locale, and the images they name. */
export interface Look {
  theme: Theme;
  strings: Record<string, LabelOverrides>;
  /** File name to bytes, for every config-folder image the theme or the catalog names. */
  media: ReadonlyMap<string, Media>;
  /** Origins of the https images the config names: the only third parties the content security policy admits. */
  imageOrigins: string[];
}

/** A look as plain JSON (`bundleLook` in `look.ts`): what a Worker runs on, since it has no config folder. */
export interface LookBundle {
  theme: Theme;
  strings: Look["strings"];
  imageOrigins: string[];
  media: Record<string, { type: string; base64: string }>;
}

export function lookFromBundle(b: LookBundle): Look {
  const media = new Map<string, Media>();
  for (const [name, m] of Object.entries(b.media)) {
    media.set(name, { type: m.type, body: Uint8Array.from(atob(m.base64), (c) => c.charCodeAt(0)) });
  }
  return { theme: b.theme, strings: b.strings, media, imageOrigins: b.imageOrigins };
}

/** The headers of a config image: an SVG may hold script, so opened directly it runs nothing. */
export function mediaHeaders(file: Media, build: string): Record<string, string> {
  return {
    "content-type": file.type,
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    "x-ibow-build": build,
  };
}

/** Image references in the catalog (item photos). */
export function catalogImages(catalog: Catalog): string[] {
  return catalog.categories.flatMap((c) => c.items.flatMap((i) => (i.image === undefined ? [] : [i.image])));
}

/** Where an image reference is served from. */
export const imageUrl = (ref: string): string => (ref.startsWith("https://") ? ref : `/media/${ref}`);

export interface ThemeDeps {
  look: Look;
  store: Store;
  /** The client build id, so a theme sheet is cached per build and per theme version. */
  build: string;
  timeZone: string;
  now: () => number;
}

function parseStored(base: Theme, json: string | undefined): Theme {
  if (json === undefined) return base;
  try {
    return applyOverride(base, JSON.parse(json));
  } catch {
    // A saved override that no longer validates (the config changed under it) is ignored, never a reason not to boot.
    return base;
  }
}

/** What the rest of the server asks of the look in force. */
export interface ThemeHandle {
  headerColor(): string;
}

export function registerTheme(http: Hono<Env>, deps: ThemeDeps): ThemeHandle {
  const { look, store, build } = deps;
  let effective = parseStored(look.theme, store.themeOverride());
  let css = themeCss(effective, imageUrl);
  let version = createHash("sha256").update(css).digest("hex").slice(0, 10);
  const refresh = () => {
    effective = parseStored(look.theme, store.themeOverride());
    css = themeCss(effective, imageUrl);
    version = createHash("sha256").update(css).digest("hex").slice(0, 10);
  };

  http.get("/theme.css", (c) => {
    const etag = `"${build}-${version}"`;
    const headers = {
      "content-type": "text/css; charset=utf-8",
      etag,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "x-ibow-build": build,
    };
    if (c.req.header("if-none-match") === etag) return c.body(null, 304, headers);
    return c.body(css, 200, headers);
  });

  http.get("/media/:file", (c) => {
    const file = look.media.get(c.req.param("file"));
    if (file === undefined) return c.notFound();
    return c.body(new Uint8Array(file.body), 200, mediaHeaders(file, build));
  });

  // The two computed figures come from two bounded aggregate queries (D-050). They are computed at boot and when the
  // owner saves a look, and refreshed in the background when older than FIGURES_MS: a request only ever reads the cache.
  interface Figures {
    at: number;
    popular: Record<string, string>;
    eta: number | undefined;
  }
  const compute = (): Figures => {
    const at = deps.now();
    return {
      at,
      popular: effective.features.tags === "auto" ? popularTags(store.topSellers(at - 7 * DAY_MS)) : {},
      eta: effective.features.cartEta ? typicalWaitMinutes(store.recentWaitsMs(at - 3 * DAY_MS)) : undefined,
    };
  };
  let figures = compute();
  let refreshing = false;
  function cached(): Figures {
    if (!refreshing && deps.now() - figures.at >= FIGURES_MS) {
      refreshing = true;
      const timer = setTimeout(() => {
        figures = compute();
        refreshing = false;
      }, 0);
      // Node would wait for the timer to end the process; a Worker's timer has no unref.
      (timer as { unref?: () => void }).unref?.();
    }
    return figures;
  }

  http.get("/api/theme", (c) => {
    const { header, logo, categoryIcons, features } = effective;
    const f = cached();
    return c.json({
      version,
      header: { style: header.style },
      ...(logo ? { logo } : {}),
      categoryIcons,
      features,
      strings: look.strings,
      popular: f.popular,
      ...(f.eta === undefined ? {} : { etaMinutes: f.eta }),
    });
  });

  // ── The owner's Appearance ─────────────────────────────────────────────────────────────────────────────────────

  function owner(c: Context<Env>): void {
    const s = c.get("session");
    if (s === undefined) throw new ApiError(401, "no_session", "expected a staff or owner session, found none");
    if (s.role !== "owner") throw new ApiError(403, "forbidden", `expected the owner, found ${s.role} ${s.user}`);
  }
  const state = () => ({
    base: look.theme,
    effective,
    overridden: store.themeOverride() !== undefined,
    version,
    warnings: checkContrast(effective).filter((w) => !w.ok),
  });

  http.get("/api/owner/theme", (c) => {
    owner(c);
    return c.json(state());
  });

  http.put("/api/owner/theme", async (c) => {
    owner(c);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError(400, "bad_json", "expected a JSON body, found something that does not parse");
    }
    try {
      applyOverride(look.theme, raw);
    } catch (e) {
      if (e instanceof ConfigError) throw new ApiError(400, "bad_theme", e.message);
      throw e;
    }
    store.setThemeOverride(JSON.stringify(raw));
    figures = compute();
    refresh();
    return c.json(state());
  });

  http.delete("/api/owner/theme", (c) => {
    owner(c);
    store.setThemeOverride(undefined);
    figures = compute();
    refresh();
    return c.json(state());
  });
  return { headerColor: () => effective.colors.header };
}
