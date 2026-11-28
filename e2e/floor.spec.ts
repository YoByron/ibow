/**
 * M16 on the floor, in a browser against the real server: counter-first holds an order off the kitchen until the counter
 * confirms its payment (D-101), a station card's timer runs (D-105), and the counter's search finds an order by the end of
 * its number (D-106).
 */

import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { addSized } from "./helpers.ts";
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

async function openScreen(ctx: BrowserContext, base: string, user: string, pin: string, hash: string): Promise<Page> {
  const login = await ctx.request.post(`${base}/api/login`, { data: { user, pin } });
  expect(login.status()).toBe(200);
  const page = await ctx.newPage();
  await page.goto(`${base}/staff${hash}`);
  await page.getByRole("button", { name: "Tap to start (turns sound on)" }).click();
  return page;
}

async function addStaff(s: RunningServer, id: string, pin: string, role: string): Promise<void> {
  expect((await s.staff("PUT", `/api/staff/${id}`, { name: id, pin, role })).status).toBe(200);
}

test("counter first: the guest is told to pay at the counter, and the kitchen sees the order only once it is paid", async ({
  browser,
}) => {
  server = await startServer("coffee-cart");
  const s = server;
  expect((await s.staff("PUT", "/api/flags/ops.counterFirst", { value: true })).status).toBe(200);
  await addStaff(s, "barista", "2468", "station");
  const bar = await openScreen(await staffContext(browser), s.base, "barista", "2468", "#/station/bar");
  const counter = await openScreen(await staffContext(browser), s.base, "owner", OWNER_PIN, "#/counter");

  const guest = await (await browser.newContext(phone)).newPage();
  await guest.goto(s.base);
  await addSized(guest, "Espresso", "S");
  await guest.getByTestId("cart-bar").click();
  // No UPI here, so no choice: one banner, worded for counter-first.
  await expect(guest.getByTestId("pay-banner")).toHaveText("Pay at the counter to confirm your order");
  await expect(guest.getByRole("radiogroup")).toHaveCount(0);
  await guest.getByRole("button", { name: /Place order/ }).click();
  await expect(guest.getByTestId("pay-first")).toContainText("Pay at the counter to confirm your order");

  const card = counter.locator("[data-testid^=order-]");
  await expect(card).toHaveCount(1);
  // The counter has it; the kitchen does not, even after a reload.
  await bar.reload();
  await bar.getByRole("button", { name: "Tap to start (turns sound on)" }).click();
  await expect(bar.getByTestId("batch-text")).toBeAttached();
  await expect(bar.locator("[data-testid^=item-]")).toHaveCount(0);

  await card.getByRole("button", { name: "Cash", exact: true }).click();
  await counter.getByRole("button", { name: /^Cash received:/ }).click();
  await expect(bar.getByTestId("item-espresso")).toBeVisible();
  await expect(guest.getByTestId("pay-first")).toHaveCount(0);
});

test("a station card's timer runs from the time of ordering", async ({ browser }) => {
  server = await startServer("service-desk");
  const s = server;
  await addStaff(s, "bench-1", "2468", "station");
  const created = await s.staff("POST", "/api/orders", {
    clientKey: `e2e-floor-timer-${Date.now()}`,
    lines: [{ itemId: "water-damage-check", qty: 1 }],
  });
  expect(created.status).toBe(201);
  const { token } = (created.body as { order: { token: string } }).order;
  const bench = await openScreen(await staffContext(browser), s.base, "bench-1", "2468", "#/station/workshop");
  const clock = bench.getByTestId(`job-${token}`).getByRole("timer");
  await expect(clock).toHaveText(/^0:0\d$/);
  const first = await clock.textContent();
  await expect.poll(() => clock.textContent(), { timeout: 5_000 }).not.toBe(first);
  await expect(clock).toHaveAttribute("data-tone", "fresh");
});

test("the counter's search finds order 39 from two taps on its keypad, and clearing restores the queue", async ({
  browser,
}) => {
  server = await startServer("coffee-cart");
  const s = server;
  const tokens: string[] = [];
  for (let i = 0; i < 40; i++) {
    const r = await s.staff("POST", "/api/orders", {
      clientKey: `e2e-floor-search-${i}-${Date.now()}`,
      lines: [{ itemId: "espresso", size: "S", qty: 1 }],
    });
    expect(r.status).toBe(201);
    tokens.push((r.body as { order: { token: string } }).order.token);
  }
  const t39 = tokens[38] as string;
  expect(t39).toMatch(/-039$/);
  const counter = await openScreen(await staffContext(browser), s.base, "owner", OWNER_PIN, "#/counter");
  const cards = counter.locator("main [data-testid^=order-]");
  await expect(cards).toHaveCount(40);
  await expect(cards.first()).toHaveAttribute("data-testid", `order-${tokens[0]}`);

  await counter.getByTestId("search-pad").click();
  await counter.getByRole("button", { name: "3", exact: true }).click();
  await counter.getByRole("button", { name: "9", exact: true }).click();
  await expect(counter.getByTestId("search")).toHaveValue("39");
  await expect(cards.first()).toHaveAttribute("data-testid", `order-${t39}`);
  await expect(cards.first()).toHaveClass(/match/);
  await expect(counter.locator(".order-card.match")).toHaveCount(1);

  await counter.getByRole("button", { name: "Clear search" }).first().click();
  await expect(counter.getByTestId("search")).toHaveValue("");
  await expect(cards.first()).toHaveAttribute("data-testid", `order-${tokens[0]}`);
  await expect(counter.locator(".order-card.match")).toHaveCount(0);
});
