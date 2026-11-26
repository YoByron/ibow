/**
 * M10 checkpoint in a real browser: a customer scans a table's QR, picks extras and a note, the order carries the spot
 * to the station, and the runner screen follows the order from "being made" to delivered.
 */

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { OWNER_PIN, type RunningServer, startServer } from "./server.ts";

let server: RunningServer | undefined;
test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

/**
 * The sample with its opening hours taken out, so ordering works whatever the time is where the test runs (the sample
 * stops taking orders after its last-order time; that rule has its own unit tests).
 */
function anyHourConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "ibow-e2e-cfg-"));
  cpSync(fileURLToPath(new URL("../samples/garden-cafe", import.meta.url)), dir, { recursive: true });
  const file = join(dir, "business.json");
  const business = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  delete business.hours;
  writeFileSync(file, JSON.stringify(business));
  return dir;
}

const phone = { isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } };

test("a table QR sets the spot, extras and a note reach the station and the runner follows the order", async ({
  browser,
}) => {
  server = await startServer("garden-cafe", { CONFIG_DIR: anyHourConfig() });
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage();
  await page.goto(`${server.base}/?spot=garden-t4`);

  await page.getByRole("button", { name: "Add Latte" }).click();
  await page.getByRole("radio", { name: /^Large/ }).click();
  await page.getByRole("radio", { name: /Oat milk/ }).click();
  await page.getByRole("checkbox", { name: /Extra shot/ }).click();
  await page.getByTestId("option-note").fill("extra hot");
  // 480 + 50 (oat) + 50 (shot) = 580
  await expect(page.getByTestId("sheet-add")).toContainText("5.80");
  await page.getByTestId("sheet-add").click();
  await page.getByTestId("cart-bar").click();
  await expect(page.getByText("Extra shot + Oat milk")).toBeVisible();
  await expect(page.getByTestId("spot")).toHaveValue("garden-t4");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByTestId("token")).toBeVisible();
  await expect(page.getByLabel("Sitting at Garden T4")).toBeVisible();

  const open = await server.staff("GET", "/api/orders");
  const order = (open.body as { orders: { id: string; spot: string; lines: { note?: string; extras: unknown[] }[] }[] })
    .orders[0];
  expect(order?.spot).toBe("Garden T4");
  expect(order?.lines[0]?.note).toBe("extra hot");
  expect(order?.lines[0]?.extras).toHaveLength(2);

  const staff = await browser.newContext(phone);
  const login = await staff.request.post(`${server.base}/api/login`, { data: { user: "owner", pin: OWNER_PIN } });
  expect(login.status()).toBe(200);
  const station = await staff.newPage();
  await station.goto(`${server.base}/staff#/station/bar`);
  await station.getByRole("button", { name: "Tap to start (turns sound on)" }).click();
  const row = station.getByTestId("item-latte");
  await expect(row.getByText("Extra shot + Oat milk")).toBeVisible();
  await expect(row.getByText("extra hot")).toBeVisible();

  const runner = await staff.newPage();
  await runner.goto(`${server.base}/staff#/runner`);
  await runner.getByRole("button", { name: "Tap to start (turns sound on)" }).click();
  const card = runner.locator("[data-testid^=run-]");
  await expect(card).toContainText("Garden T4");
  await expect(card).toContainText("0 of 1 delivered");
  await expect(card).toContainText("waiting on Barista");

  await station.getByRole("button", { name: "Ready" }).first().click();
  await expect(card).toContainText("1 ready to carry");
  // Seated by a QR, the guest is told the order is coming to them, never to collect it.
  await expect(page.getByTestId("status")).toHaveText("Ready! It is on its way to Garden T4.");
  await card.getByRole("button", { name: "Delivered" }).click();
  await expect(runner.getByText("Nothing waiting to be carried.")).toBeVisible();
  // Handed over at the table: the guest's phone says so (D-097). Not yet paid, so the counter still has the order.
  await expect(page.getByTestId("status")).toHaveText("Served at Garden T4. Enjoy!");
  await expect(page.getByText("Brought to Garden T4. Enjoy!")).toBeVisible();
  const still = (await server.staff("GET", "/api/orders")).body as { orders: { status: string }[] };
  expect(still.orders[0]?.status).not.toBe("completed");
});

test("the catalog serves the zones and the extras library", async () => {
  server = await startServer("garden-cafe");
  const r = await fetch(`${server.base}/api/catalog`);
  const catalog = (await r.json()) as { zones: { spots: unknown[] }[]; extras: { id: string }[] };
  expect(catalog.zones.flatMap((z) => z.spots).length).toBeGreaterThan(20);
  expect(catalog.extras.map((g) => g.id)).toContain("milk");
});
