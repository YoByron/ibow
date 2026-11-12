import { defineConfig } from "vitest/config";

/**
 * The Miniflare tests boot workerd for seconds each; run beside the rest on every core they starve the fast tests
 * into their timeouts. Fewer workers and roomier timeouts keep the whole suite steady on a busy machine.
 */
export default defineConfig({
  test: { testTimeout: 20_000, hookTimeout: 120_000, maxWorkers: 3 },
});
