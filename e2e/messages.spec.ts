/**
 * Guest messages in a browser against the real server (D-104): a guest's chip reaches the runner of the spot's section,
 * spoken, with an unanswered badge; the floor colours the spot as a message; the runner's one-tap reply reaches the guest
 * live and the spot goes back to its other state. Screenshots for review go to SHOTS_DIR when it is set.
 */

import { join } from "node:path";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { anyHourConfig } from "./helpers.ts";
import { OWNER_PIN, type RunningServer, startServer } from "./server.ts";

let server: RunningServer | undefined;
test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

const phone = { isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } };
const shots = process.env.SHOTS_DIR;

/** Speech is stubbed and every utterance kept, so a test can read what a screen said. */
function stubSpeech(): void {
  const said: string[] = [];
  (window as unknown as { said: string[] }).said = said;
  const synth = {
    speak(u: SpeechSynthesisUtterance) {
      said.push(u.text);
      setTimeout(() => u.onend?.call(u, new Event("end") as SpeechSynthesisEvent), 10);
    },
    cancel() {},
  };
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
}

async function staffContext(browser: Browser, dark = false): Promise<BrowserContext> {
  const ctx = await browser.newContext({ ...phone, colorScheme: dark ? "dark" : "light" });
  await ctx.addInitScript(stubSpeech);
  return ctx;
}

async function signIn(ctx: BrowserContext, base: string, user: string, pin: string): Promise<void> {
  const login = await ctx.request.post(`${base}/api/login`, { data: { user, pin } });
  expect(login.status()).toBe(200);
}

async function openScreen(ctx: BrowserContext, base: string, hash: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(`${base}/staff${hash}`);
  await page.getByRole("button", { name: "Tap to start (turns sound on)" }).click();
  return page;
}

/** A guest orders a carrot cake at a spot from the storefront and lands on the token page. */
async function guestOrders(browser: Browser, base: string, spot: string, dark = false): Promise<Page> {
  const guest = await (await browser.newContext({ ...phone, colorScheme: dark ? "dark" : "light" })).newPage();
  await guest.goto(base);
  await guest.getByRole("button", { name: "Add Carrot cake" }).click();
  await guest.getByTestId("cart-bar").click();
  await guest.getByTestId("spot").selectOption(spot);
  await guest.getByRole("button", { name: "Place order" }).click();
  await expect(guest.getByTestId("messages")).toBeVisible();
  return guest;
}

async function shot(page: Page, name: string, el?: ReturnType<Page["getByTestId"]>): Promise<void> {
  if (shots === undefined) return;
  if (el !== undefined) await el.evaluate((e) => e.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, name) });
}

test("a guest's message reaches the section's runner, the floor shows it, and the runner's reply reaches the guest", async ({
  browser,
}) => {
  server = await startServer("garden-cafe", { CONFIG_DIR: anyHourConfig() });
  const s = server;
  expect((await s.staff("PUT", "/api/staff/asha", { name: "Asha", pin: "2468", role: "counter" })).status).toBe(200);
  expect((await s.staff("PUT", "/api/sections/garden/runner", { user: "asha" })).status).toBe(200);

  const asha = await staffContext(browser, true);
  await signIn(asha, s.base, "asha", "2468");
  const runner = await openScreen(asha, s.base, "#/runner");
  const owner = await staffContext(browser);
  await signIn(owner, s.base, "owner", OWNER_PIN);
  const floor = await openScreen(owner, s.base, "#/floor");

  const guest = await guestOrders(browser, s.base, "garden-t2");
  const token = await orderToken(s);
  const spot = floor.getByTestId("fl-spot-garden-t2");
  await expect(spot).toHaveAttribute("data-state", "ordered");

  await guest.getByTestId("msg-chip-water").click();
  await expect(guest.getByTestId("msg-thread")).toContainText("Water, please");

  const card = runner.getByTestId(`run-${token}`);
  await expect(card.getByTestId(`msg-badge-${token}`)).toBeVisible();
  await expect(card.getByTestId(`thread-${token}`)).toContainText("Water, please");
  await expect
    .poll(() => runner.evaluate(() => (window as unknown as { said: string[] }).said.join(" | ")))
    .toContain("asks: Water, please");
  await expect(spot).toHaveAttribute("data-state", "message");

  await card.getByRole("button", { name: "Coming" }).click();
  await expect(guest.getByTestId("msg-thread")).toContainText("Coming");
  await expect(card.getByTestId(`msg-badge-${token}`)).toHaveCount(0);
  await expect(spot).toHaveAttribute("data-state", "ordered");

  // A typed line, answered with a typed line, for the screenshots.
  await guest.getByTestId("msg-text").fill("Could we have a high chair, please?");
  await guest.getByTestId("msg-send").click();
  // One guest message per 10 seconds: the guest is told to wait, and the line stays typed for the retry.
  await expect(guest.getByTestId("messages").getByRole("alert")).toContainText("wait a few seconds");
  await expect(guest.getByTestId("msg-text")).toHaveValue("Could we have a high chair, please?");
  await guest.waitForTimeout(10_000);
  await guest.getByTestId("msg-send").click();
  await expect(card.getByTestId(`thread-${token}`)).toContainText("high chair");
  await shot(runner, "msg-runner-dark.png");
  await card.getByPlaceholder("Short reply").fill("Bringing one now");
  await card.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(guest.getByTestId("msg-thread")).toContainText("Bringing one now");
  await shot(guest, "msg-guest-light.png", guest.getByTestId("messages"));
});

test("the token page's thread in dark mode", async ({ browser }) => {
  test.skip(shots === undefined, "screenshots only");
  server = await startServer("garden-cafe", { CONFIG_DIR: anyHourConfig() });
  const s = server;
  const guest = await guestOrders(browser, s.base, "garden-t5", true);
  await guest.getByTestId("msg-chip-bill").click();
  await expect(guest.getByTestId("msg-thread")).toContainText("The bill, please");
  const id = ((await s.staff("GET", "/api/orders")).body as { orders: { id: string }[] }).orders[0]?.id as string;
  expect((await s.staff("POST", `/api/orders/${id}/reply`, { chip: "twoMinutes" })).status).toBe(201);
  await expect(guest.getByTestId("msg-thread")).toContainText("2 minutes");
  await shot(guest, "msg-guest-dark.png", guest.getByTestId("messages"));
});

/** The token of the one open order. */
async function orderToken(s: RunningServer): Promise<string> {
  const orders = ((await s.staff("GET", "/api/orders")).body as { orders: { token: string }[] }).orders;
  expect(orders).toHaveLength(1);
  return orders[0]?.token as string;
}
