import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Config, loadConfig, type RawConfig } from "../../src/core/config.ts";

const root = fileURLToPath(new URL("../../samples/", import.meta.url));

/** Parses one JSON file of the sample business in `samples/<sample>/`. */
export function readSample(sample: string, file: string): unknown {
  return JSON.parse(readFileSync(`${root}${sample}/${file}`, "utf8"));
}

export function sampleRaw(sample: string): RawConfig {
  return {
    business: readSample(sample, "business.json"),
    catalog: readSample(sample, "catalog.json"),
    stations: readSample(sample, "stations.json"),
  };
}

export function loadSample(sample: string): Config {
  return loadConfig(sampleRaw(sample));
}
