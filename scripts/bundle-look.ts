// The look of a config folder (theme.json, strings.<locale>.json, the images they name) as one JSON file for a Worker,
// which has no config folder to read at runtime (D-052). `wrangler.toml` aliases `ibow-look` to the file this writes.
//   node scripts/bundle-look.ts <config-dir> <out.json>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCatalog } from "../src/core/config.ts";
import { bundleLook, loadLook } from "../src/server/look.ts";
import type { LookBundle } from "../src/server/theme.ts";

/** Loads and validates the look of `dir` (failing with the file and field if anything is wrong) as a bundle. */
export function lookBundleOf(dir: string): LookBundle {
  const file = join(dir, "catalog.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`ibow: expected a JSON file at ${file}, found: ${(e as Error).message}`);
  }
  return bundleLook(loadLook(dir, parseCatalog(raw, file)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, out] = process.argv.slice(2);
  if (dir === undefined || out === undefined) {
    throw new Error("ibow: expected two arguments, <config-dir> <out.json>, found fewer");
  }
  const bundle = lookBundleOf(resolve(dir));
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), JSON.stringify(bundle));
  console.log(
    `look: ${Object.keys(bundle.media).length} images, ${Object.keys(bundle.strings).length} locales -> ${out}`,
  );
}
