/**
 * The business, bundled at deploy time (Principle 5: config, never code, describes a shop). `ibow-business`, `ibow-catalog` and
 * `ibow-stations` are aliases the build points at the three files: `./config/*.json` for a real install (wrangler.toml), a
 * sample's for the demo. `ibow-rush` is the sample's rush.json for a demo seed, an empty stub otherwise.
 */

import business from "ibow-business" with { type: "json" };
import catalog from "ibow-catalog" with { type: "json" };
import marker from "ibow-demo-bundle" with { type: "json" };
import look from "ibow-look" with { type: "json" };
import rushJson from "ibow-rush" with { type: "json" };
import spots from "ibow-spots" with { type: "json" };
import stations from "ibow-stations" with { type: "json" };
import { loadConfig } from "../core/config.ts";
import type { DemoRush } from "../demo/seed.ts";
import { type LookBundle, lookFromBundle } from "../server/theme.ts";

export const config = loadConfig({ business, catalog, stations, spots });
/** The theme, strings and images of the config folder, bundled at deploy time by scripts/bundle-look.ts (D-052). */
export const looks = lookFromBundle(look as unknown as LookBundle);
export const rush = rushJson as unknown as DemoRush;
/** True only in a bundle built from `wrangler.demo.toml`, whose marker file says so (D-040). */
export const demoBundle = (marker as { demo?: unknown }).demo === true;
