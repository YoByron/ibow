// Regenerates a sample's synthetic rush: node scripts/gen-rush.ts <sample>
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseCatalog, parseSpots } from "../src/core/config.ts";
import { generateRush, SAMPLE_RUSHES } from "../tests/support/rush.ts";

const sample = process.argv[2] ?? "";
const opts = SAMPLE_RUSHES[sample];
if (opts === undefined) {
  throw new Error(
    `gen-rush: expected one of ${Object.keys(SAMPLE_RUSHES).join(", ")}, found ${JSON.stringify(sample)}`,
  );
}
const dir = new URL(`../samples/${sample}/`, import.meta.url);
const catalog = parseCatalog(JSON.parse(readFileSync(new URL("catalog.json", dir), "utf8")));
const spots = new URL("spots.json", dir);
const zones = existsSync(spots) ? parseSpots(JSON.parse(readFileSync(spots, "utf8"))) : [];
writeFileSync(new URL("rush.json", dir), `${JSON.stringify(generateRush(catalog, opts, zones))}\n`);
