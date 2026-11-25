/**
 * The look of an install, loaded from its config folder (Node) or from a bundle made at deploy time (Workers, D-052).
 * `loadLook` is the one place that reads `theme.json`, `strings.<locale>.json` and the images they name; a Worker has
 * no files, so `bundleLook` turns the loaded look into plain JSON that the deploy build bundles beside the business.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { parseEvents } from "../core/calendar.ts";
import { type Catalog, ConfigError } from "../core/config.ts";
import { parseStrings } from "../core/labels.ts";
import { DEFAULT_THEME, parseTheme, themeImages } from "../core/theme.ts";
import { catalogImages, type Look, type LookBundle, type Media } from "./theme.ts";

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};
const LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`ibow: expected a JSON file at ${path}, found: ${(e as Error).message}`);
  }
}

/**
 * Reads `theme.json` and `strings.<locale>.json` from the config folder (both optional) and every image they and the
 * catalog name, failing at boot with the file and field if any is wrong or missing.
 */
export function loadLook(dir: string, catalog: Catalog): Look {
  const themeFile = join(dir, "theme.json");
  const theme = existsSync(themeFile) ? parseTheme(readJson(themeFile), "theme.json") : DEFAULT_THEME;
  const strings: Look["strings"] = {};
  for (const name of readdirSync(dir)) {
    const m = /^strings\.(.+)\.json$/.exec(name);
    if (!m) continue;
    const locale = m[1] as string;
    if (!LOCALE.test(locale)) {
      throw new ConfigError(
        name,
        "",
        "a file named strings.<locale>.json, such as strings.hi.json",
        `locale ${locale}`,
      );
    }
    strings[locale] = parseStrings(readJson(join(dir, name)), name);
  }
  const refs = new Set([...themeImages(theme), ...catalogImages(catalog)]);
  const media = new Map<string, Media>();
  const origins = new Set<string>();
  for (const ref of refs) {
    if (ref.startsWith("https://")) {
      origins.add(new URL(ref).origin);
      continue;
    }
    const path = join(dir, ref);
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new ConfigError("config folder", ref, `an image file in ${dir}`, "no such file");
    }
    if (statSync(path).size > MAX_IMAGE_BYTES) {
      throw new ConfigError(
        "config folder",
        ref,
        `an image up to ${MAX_IMAGE_BYTES} bytes`,
        `${statSync(path).size} bytes`,
      );
    }
    media.set(ref, { body: readFileSync(path), type: IMAGE_TYPES[extname(ref).toLowerCase()] as string });
  }
  // The calendar's first events (D-084): optional, checked here so a bad file stops the boot with its field.
  const eventsFile = join(dir, "events.json");
  const events = existsSync(eventsFile) ? parseEvents(readJson(eventsFile), "events.json") : undefined;
  return { theme, strings, media, imageOrigins: [...origins].sort(), ...(events === undefined ? {} : { events }) };
}

/** The look as plain JSON, for a Worker, which has no config folder: the deploy build bundles it beside the business. */
export function bundleLook(look: Look): LookBundle {
  return {
    theme: look.theme,
    strings: look.strings,
    imageOrigins: look.imageOrigins,
    ...(look.events === undefined ? {} : { events: look.events }),
    media: Object.fromEntries(
      [...look.media].map(([name, m]) => [name, { type: m.type, base64: Buffer.from(m.body).toString("base64") }]),
    ),
  };
}
