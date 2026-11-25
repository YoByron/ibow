/**
 * M14 checkpoint in a real browser: a guest in a room orders onto the room bill, staff settle the room at checkout, and the
 * owner's Received moves only then; and the business's events show on the splash and the storefront.
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

const phone = { isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } };

/** The garden cafe open at any hour (its hours are unit-tested), with `events.json` when given. */
function config(events?: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "ibow-e2e-stays-"));
  cpSync(fileURLToPath(new URL("../samples/garden-cafe", import.meta.url)), dir, { recursive: true });
  const file = join(dir, "business.json");
  const business = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  delete business.hours;
  writeFileSync(file, JSON.stringify(business));
  if (events) writeFileSync(join(dir, "events.json"), JSON.stringify(events));
  return dir;
}

interface Insights {
  report: { totals: { orderedMinor: number; receivedMinor: number } };
  rooms?: { open: number; totalMinor: number };
}

test("a guest in a room orders onto the room bill; Received moves only when staff settle at checkout", async ({
  browser,
}) => {
  server = await startServer("garden-cafe", { CONFIG_DIR: config() });
  // A guest who only knows the room's number (no key from its QR) is never offered the room bill.
  const stranger = await (await browser.newContext(phone)).newPage();
  await stranger.goto(`${server.base}/?spot=rooms-2`);
  await stranger.getByRole("button", { name: "Add Carrot cake" }).click();
  await stranger.getByTestId("cart-bar").click();
  await expect(stranger.getByRole("button", { name: "Place order" })).toBeVisible();
  await expect(stranger.getByRole("radio", { name: /Add to my room bill/ })).toHaveCount(0);
  await expect(stranger.locator("[data-testid=spot] option[value=rooms-3]")).toHaveCount(0);

  // The QR in the room carries its key, as the owner's Spots page prints it.
  const keys = ((await server.staff("GET", "/api/rooms/keys")).body as { keys: Record<string, string> }).keys;
  const guest = await (await browser.newContext(phone)).newPage();
  await guest.goto(`${server.base}/?spot=rooms-2&key=${keys["rooms-2"]}`);
  // The key leaves the address bar at once, so a link the guest shares does not carry it; this tab keeps it.
  await expect(guest).toHaveURL(`${server.base}/?spot=rooms-2`);
  await guest.getByRole("button", { name: "Add Carrot cake" }).click();
  await guest.getByTestId("cart-bar").click();
  await expect(guest.getByTestId("spot")).toHaveValue("rooms-2");
  await guest.getByRole("radio", { name: /Add to my room bill/ }).click();
  await guest.getByRole("button", { name: "Place order" }).click();
  await expect(guest.getByTestId("token")).toBeVisible();
  await expect(guest.getByTestId("room-bill")).toHaveText("On your room bill. We'll bring it to your room.");

  const before = (await server.staff("GET", "/api/owner/insights")).body as Insights;
  expect(before.report.totals).toMatchObject({ orderedMinor: 420, receivedMinor: 0 });
  expect(before.rooms).toEqual({ open: 1, totalMinor: 420 });

  const staff = await browser.newContext(phone);
  expect(
    (await staff.request.post(`${server.base}/api/login`, { data: { user: "owner", pin: OWNER_PIN } })).status(),
  ).toBe(200);
  // The counter shows it as on the room bill, with no way to take the money there.
  const counter = await staff.newPage();
  await counter.goto(`${server.base}/staff#/counter`);
  await counter.getByRole("button", { name: "Tap to start (turns sound on)" }).click();
  await expect(counter.getByText("On the room bill of Room 2. Settle it in Rooms at checkout.")).toBeVisible();

  const rooms = await staff.newPage();
  await rooms.goto(`${server.base}/staff#/rooms`);
  const room = rooms.getByTestId("room-rooms-2");
  await expect(room).toContainText("Room 2");
  await expect(room).toContainText("4.20");
  expect(((await server.staff("GET", "/api/owner/insights")).body as Insights).report.totals.receivedMinor).toBe(0);
  await room.getByTestId("settle-rooms-2-cash").click();
  // Money that can't be undone is confirmed first.
  const confirm = rooms.getByTestId("settle-dialog");
  await expect(confirm).toContainText("Settle Room 2?");
  await confirm.getByRole("button", { name: "Settle", exact: true }).click();
  await expect(rooms.getByText("No room has an open bill.")).toBeVisible();
  await expect(rooms.getByTestId("settlements")).toContainText("Room 2");

  const after = (await server.staff("GET", "/api/owner/insights")).body as Insights;
  expect(after.report.totals).toMatchObject({ orderedMinor: 420, receivedMinor: 420 });
  expect(after.rooms).toEqual({ open: 0, totalMinor: 0 });
  await expect(guest.getByTestId("room-bill")).toHaveText("Paid at checkout. Thank you!", { timeout: 20_000 });
});

test("the owner's New QR for a room stops its old QR; the room's guest with the new one can still charge it", async ({
  browser,
}) => {
  const running = await startServer("garden-cafe", { CONFIG_DIR: config() });
  server = running;
  const base = running.base;
  const keys = async () =>
    ((await running.staff("GET", "/api/rooms/keys")).body as { keys: Record<string, string> }).keys;
  const old = (await keys())["rooms-2"] as string;
  const owner = await browser.newContext(phone);
  expect((await owner.request.post(`${base}/api/login`, { data: { user: "owner", pin: OWNER_PIN } })).status()).toBe(
    200,
  );
  const spots = await owner.newPage();
  await spots.goto(`${base}/owner#/spots`);
  await expect(spots.getByTestId("new-qr-rooms-1")).toBeVisible();
  await spots.getByTestId("new-qr-rooms-2").click();
  const dialog = spots.getByTestId("new-qr-dialog");
  await expect(dialog).toContainText("New QR for Room 2?");
  await dialog.getByRole("button", { name: "Make a new QR" }).click();
  await expect.poll(async () => (await keys())["rooms-2"]).not.toBe(old);
  const fresh = (await keys())["rooms-2"] as string;
  await expect(spots.locator(`a[href*="key=${fresh}"]`)).toHaveCount(1);

  const order = (roomKey: string) => ({
    clientKey: `e2e-new-qr-${roomKey.slice(0, 8)}-abcdef`,
    lines: [{ itemId: "carrot-cake", qty: 1 }],
    spot: "rooms-2",
    pay: "room",
    roomKey,
  });
  const guest = await browser.newContext(phone);
  expect((await guest.request.post(`${base}/api/orders`, { data: order(old) })).status()).toBe(403);
  expect((await guest.request.post(`${base}/api/orders`, { data: order(fresh) })).status()).toBe(201);
});

test("the next event shows on the staff splash and, for guests, under the storefront's header", async ({ browser }) => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon" }).format(new Date());
  server = await startServer("garden-cafe", {
    CONFIG_DIR: config([
      {
        title: "Lantern night market",
        date: today,
        start: "00:00",
        audience: "all",
        rush: true,
        note: "In the garden",
      },
      { title: "Big produce delivery", date: today, start: "00:00", audience: "staff" },
    ]),
  });
  const ctx = await browser.newContext(phone);
  const staff = await ctx.newPage();
  await staff.goto(`${server.base}/staff`);
  const splash = staff.locator("#splash [data-testid=event-splash]");
  await expect(splash).toContainText("Lantern night market");
  await expect(splash).toContainText("Today");
  await expect(splash).toContainText("Expect a rush");
  await expect(splash).toHaveClass(/is-today/);

  const guest = await (await browser.newContext(phone)).newPage();
  await guest.goto(`${server.base}/`);
  const banner = guest.getByTestId("event-guest");
  await expect(banner).toContainText("Lantern night market");
  await expect(banner).toContainText("In the garden");
  // Guests never see a staff-only event.
  await expect(guest.getByText("Big produce delivery")).toHaveCount(0);
  await banner.getByRole("button", { name: "Hide this event" }).click();
  await expect(guest.getByTestId("event-guest")).toHaveCount(0);
  await guest.reload();
  await expect(guest.getByRole("button", { name: /Add Carrot cake/ })).toBeVisible();
  await expect(guest.getByTestId("event-guest")).toHaveCount(0);
});
