/**
 * The storefront on Chrome DevTools' "Slow 3G" profile (2 s round trip, 50 KB/s each way): the catalog must be usable
 * within a stated time on a first visit, and faster on a return visit, served by the service worker's cache.
 */

import { expect, test } from "@playwright/test";
import { type RunningServer, startServer } from "./server.ts";

/** DevTools' Slow 3G preset, as Chrome defines it. */
const SLOW_3G = { offline: false, latency: 2000, downloadThroughput: 50_000, uploadThroughput: 50_000 };
const FIRST_VISIT_MS = 12_000;
const RETURN_VISIT_MS = 8_000;

let server: RunningServer | undefined;
test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

test("on Slow 3G the catalog is usable within 12 s on a first visit, and sooner from the service worker", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  server = await startServer("coffee-cart");
  const context = await browser.newContext({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", SLOW_3G);
  const espresso = page.getByRole("button", { name: "Add Espresso" });

  const t0 = Date.now();
  await page.goto(`${server.base}/`, { waitUntil: "commit" });
  await expect(espresso).toBeVisible({ timeout: FIRST_VISIT_MS + 5_000 });
  const first = Date.now() - t0;
  await espresso.click();
  await page.getByRole("radio", { name: /^S/ }).click();
  await page.getByTestId("sheet-add").click();
  await expect(page.getByTestId("cart-bar")).toContainText("$3");

  // Wait for the worker to hold this build, then come back.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(() => page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith("ibow-")).length), {
      timeout: 30_000,
    })
    .toBe(1);
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  const t1 = Date.now();
  await page.reload({ waitUntil: "commit" });
  await expect(espresso).toBeVisible({ timeout: RETURN_VISIT_MS + 5_000 });
  const again = Date.now() - t1;

  console.log(`slow 3G: catalog usable after ${first} ms on a first visit, ${again} ms on a return visit`);
  expect(first).toBeLessThan(FIRST_VISIT_MS);
  expect(again).toBeLessThan(RETURN_VISIT_MS);
  expect(again).toBeLessThan(first);
});
