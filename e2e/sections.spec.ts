/**
 * M16 part B in a browser against the real server: the runner hands over a line no station marked ready (a kitchen
 * without a screen), the owner edits the sections and the storefront offers the new spot (D-102), a runner sees their
 * own sections first and a section with nobody too (D-103), and the floor colours a spot with an order (D-103).
 */

import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { anyHourConfig } from "./helpers.ts";
import { OWNER_PIN, type RunningServer, startServer } from "./server.ts";

let server: RunningServer | undefined;
test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

const phone = { isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } };

/** Speech is stubbed so the start button's sound needs no real engine. */
function stubSpeech(): void {
  const synth = {
    speak(u: SpeechSynthesisUtterance) {
      setTimeout(() => u.onend?.call(u, new Event("end") as SpeechSynthesisEvent), 10);
    },
    cancel() {},
  };
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
}

async function staffContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext(phone);
  await ctx.addInitScript(stubSpeech);
  return ctx;
}

async function signIn(ctx: BrowserContext, base: string, user: string, pin: string): Promise<void> {
  const login = await ctx.request.post(`${base}/api/login`, { data: { user, pin } });
  expect(login.status()).toBe(200);
}

/** A screen that sounds (counter, runner, floor) asks for one tap first. */
async function openScreen(ctx: BrowserContext, base: string, hash: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(`${base}/staff${hash}`);
  await page.getByRole("button", { name: "Tap to start (turns sound on)" }).click();
  return page;
}

/** An order keyed in by staff (the owner's session), so the sample's opening hours don't matter. */
async function order(s: RunningServer, key: string, spot: string, itemId = "carrot-cake"): Promise<string> {
  const r = await s.staff("POST", "/api/orders", {
    clientKey: `e2e-sections-${key}-0000000000`,
    lines: [{ itemId, qty: 1 }],
    spot,
  });
  expect(r.status).toBe(201);
  return (r.body as { order: { token: string } }).order.token;
}

test("the runner hands over a line no station marked ready", async ({ browser }) => {
  server = await startServer("garden-cafe");
  const s = server;
  const token = await order(s, "unready", "garden-t2");
  const ctx = await staffContext(browser);
  await signIn(ctx, s.base, "owner", OWNER_PIN);
  const runner = await openScreen(ctx, s.base, "#/runner");
  const card = runner.getByTestId(`run-${token}`);
  await expect(card).toContainText("0 of 1 delivered");
  await card.getByRole("button", { name: "Delivered" }).click();
  await expect(runner.getByText("Nothing waiting to be carried.")).toBeVisible();
});

test("under counter-first the runner shows an unpaid order as awaiting payment, with no Delivered, until it is paid", async ({
  browser,
}) => {
  server = await startServer("garden-cafe");
  const s = server;
  expect((await s.staff("PUT", "/api/flags/ops.counterFirst", { value: true })).status).toBe(200);
  const r = await s.staff("POST", "/api/orders", {
    clientKey: "e2e-sections-first-0000000000",
    lines: [{ itemId: "carrot-cake", qty: 1 }],
    spot: "garden-t4",
  });
  const { id, token, totalMinor } = (r.body as { order: { id: string; token: string; totalMinor: number } }).order;
  const ctx = await staffContext(browser);
  await signIn(ctx, s.base, "owner", OWNER_PIN);
  const runner = await openScreen(ctx, s.base, "#/runner");
  const card = runner.getByTestId(`run-${token}`);
  await expect(card.getByTestId(`awaiting-${token}`)).toHaveText("Awaiting payment");
  await expect(card.getByRole("button", { name: "Delivered", exact: true })).toHaveCount(0);
  await s.staff("POST", `/api/orders/${id}/confirm`, { method: "cash", amountMinor: totalMinor });
  await expect(card.getByTestId(`awaiting-${token}`)).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Delivered", exact: true })).toHaveCount(1);
});

test("Delivered sits in the same place on every runner line at 390px, whatever the line's length", async ({
  browser,
}) => {
  server = await startServer("garden-cafe");
  const s = server;
  const r = await s.staff("POST", "/api/orders", {
    clientKey: "e2e-sections-layout-0000000000",
    lines: [
      { itemId: "espresso", qty: 1 },
      { itemId: "pancakes", qty: 2, note: "no syrup on one, extra banana on the other please" },
      { itemId: "masala-eggs", qty: 1 },
    ],
    spot: "garden-t3",
  });
  const token = (r.body as { order: { token: string } }).order.token;
  const ctx = await staffContext(browser);
  await signIn(ctx, s.base, "owner", OWNER_PIN);
  const runner = await openScreen(ctx, s.base, "#/runner");
  const buttons = runner.getByTestId(`run-${token}`).getByRole("button", { name: "Delivered", exact: true });
  await expect(buttons).toHaveCount(3);
  const boxes = await Promise.all([0, 1, 2].map(async (i) => (await buttons.nth(i).boundingBox()) ?? undefined));
  const rights = boxes.map((b) => Math.round((b?.x ?? 0) + (b?.width ?? 0)));
  expect(new Set(rights).size).toBe(1);
  // At the right edge, inside the 390px screen.
  expect(rights[0]).toBeGreaterThan(300);
  expect(rights[0]).toBeLessThanOrEqual(390);
});

test("the owner adds a section and a spot, and the storefront offers the new spot", async ({ browser }) => {
  server = await startServer("garden-cafe", { CONFIG_DIR: anyHourConfig() });
  const s = server;
  const ctx = await browser.newContext(phone);
  await signIn(ctx, s.base, "owner", OWNER_PIN);
  const editor = await ctx.newPage();
  await editor.goto(`${s.base}/staff#/sections`);
  await editor.getByTestId("sec-add").click();
  const last = editor.locator("[data-testid^=sec-name-]").last();
  await last.fill("Patio");
  await editor.locator("[data-testid^=sec-add-spot-]").last().click();
  await editor.locator("[data-testid^=sec-spot-]").last().fill("P1");
  await editor.getByTestId("sec-save").click();
  await expect(editor.getByRole("status")).toContainText("Saved");

  const guest = await (await browser.newContext(phone)).newPage();
  await guest.goto(s.base);
  await guest.getByRole("button", { name: "Add Carrot cake" }).click();
  await guest.getByTestId("cart-bar").click();
  await expect(guest.getByTestId("spot").locator("option", { hasText: "Patio P1" })).toHaveCount(1);
  await guest.getByTestId("spot").selectOption("patio-p1");
  await guest.getByRole("button", { name: "Place order" }).click();
  await expect(guest.getByLabel("Sitting at Patio P1")).toBeVisible();
});

test("a runner sees their own section's order and an unassigned section's under My sections, the rest under All", async ({
  browser,
}) => {
  server = await startServer("garden-cafe");
  const s = server;
  for (const id of ["asha", "ravi"]) {
    expect((await s.staff("PUT", `/api/staff/${id}`, { name: id, pin: "2468", role: "counter" })).status).toBe(200);
  }
  expect((await s.staff("PUT", "/api/sections/garden/runner", { user: "asha" })).status).toBe(200);
  expect((await s.staff("PUT", "/api/sections/terrace/runner", { user: "ravi" })).status).toBe(200);
  const own = await order(s, "own", "garden-t1");
  const nobody = await order(s, "nobody", "other-hammock");
  const theirs = await order(s, "theirs", "terrace-1");

  const ctx = await staffContext(browser);
  await signIn(ctx, s.base, "asha", "2468");
  const runner = await openScreen(ctx, s.base, "#/runner");
  await expect(runner.getByTestId(`run-${own}`)).toBeVisible();
  await expect(runner.getByTestId(`run-${nobody}`)).toBeVisible();
  await expect(runner.getByTestId(`run-${theirs}`)).toHaveCount(0);
  await runner.getByTestId("scope-all").click();
  await expect(runner.getByTestId(`run-${theirs}`)).toBeVisible();
  await expect(runner.getByRole("heading", { name: "Other sections" })).toBeVisible();
});

test("the floor shows a spot with an order as ordered, and assigns the section's runner", async ({ browser }) => {
  server = await startServer("garden-cafe");
  const s = server;
  expect((await s.staff("PUT", "/api/staff/asha", { name: "Asha", pin: "2468", role: "counter" })).status).toBe(200);
  const token = await order(s, "floor", "garden-t3");
  const ctx = await staffContext(browser);
  await signIn(ctx, s.base, "owner", OWNER_PIN);
  const floor = await openScreen(ctx, s.base, "#/floor");
  const spot = floor.getByTestId("fl-spot-garden-t3");
  await expect(spot).toHaveAttribute("data-state", "ordered");
  await expect(spot).toHaveAccessibleName("Garden T3, Ordered");
  await expect(floor.getByTestId("fl-spot-garden-t4")).toHaveAttribute("data-state", "free");
  await spot.click();
  await expect(floor.getByTestId(`fl-order-${token}`)).toContainText("Carrot cake");
  await floor.keyboard.press("Escape");
  await floor.getByTestId("fl-runner-garden").selectOption("asha");
  await expect
    .poll(async () => ((await s.staff("GET", "/api/sections")).body as { runners: Record<string, string> }).runners)
    .toEqual({ garden: "asha" });
});
