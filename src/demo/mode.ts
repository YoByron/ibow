/** Demo mode on Workers: when a database may be a demo's, and when it must be refused (D-035, D-040). */

/**
 * What `DEMO` means for this deployment and database: `real`, `seed` (a fresh database of a demo bundle, to seed) or
 * `demo` (already marked). Public PINs need all of: `DEMO=1`, the demo bundle (an explicit marker only
 * `wrangler.demo.toml` bundles), and a database that is a demo's or empty. Anything else is refused with the reason.
 */
export function demoMode(
  setting: string | undefined,
  marked: boolean,
  empty: boolean,
  bundleIsDemo: boolean,
): "demo" | "seed" | "real" {
  const on = setting !== undefined && setting !== "";
  if (on && setting !== "1") throw new Error(`ibow: expected DEMO to be 1 or unset, found ${JSON.stringify(setting)}`);
  if (on && !bundleIsDemo) {
    throw new Error(
      "ibow: DEMO=1 is set but the bundled config is not the demo bundle, so this would make a real business a public " +
        "demo with PINs shown to everyone. Unset DEMO; the demo is deployed with: npx wrangler deploy -c wrangler.demo.toml",
    );
  }
  if (!on && bundleIsDemo) {
    throw new Error("ibow: the demo bundle is deployed but DEMO=1 is not set; deploy it with wrangler.demo.toml as is");
  }
  if (!on) {
    if (marked) {
      throw new Error(
        "ibow: this database was seeded as a demo, whose PINs were shown to visitors, but DEMO is not set. " +
          "Deploy a real install under another name, or delete this Durable Object's data first",
      );
    }
    return "real";
  }
  if (marked) return "demo";
  if (empty) return "seed";
  throw new Error(
    "ibow: DEMO=1 is set but this database is not a demo's and already holds data. A demo never touches a real " +
      "install: unset DEMO, or deploy the demo under another name",
  );
}
