/**
 * M4 checkpoint: a staged rush on the staff screens against the real server. One counter and two stations in their own
 * browser contexts, ten customers (API and storefront), a walk-in at the counter, stations marking ready, a top-up after
 * added items, spoken text captured from a stubbed speechSynthesis, and the 80mm print view.
 */

import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { BATCH_TEMPLATES, type BatchTemplate, openBatch, renderBatch } from "../src/core/batches.ts";
import { orderNumber } from "../src/core/tokens.ts";
import type { StaffOrderView } from "../src/core/views.ts";
import { addSized } from "./helpers.ts";
import { OWNER_PIN, type RunningServer, startServer } from "./server.ts";

let server: RunningServer | undefined;
test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

const phone = { isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } };
const en = BATCH_TEMPLATES.en as BatchTemplate;

declare global {
  interface Window {
    __spoken: string[];
    __printed: number;
  }
}

/** Captures what the page speaks and prints instead of using the real speech engine and print dialog. */
function stubSpeechAndPrint(): void {
  window.__spoken = [];
  window.__printed = 0;
  const synth = {
    speak(u: SpeechSynthesisUtterance) {
      window.__spoken.push(u.text);
      setTimeout(() => u.onend?.call(u, new Event("end") as SpeechSynthesisEvent), 10);
    },
    cancel() {},
  };
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
  window.print = () => {
    window.__printed++;
  };
}

async function staffContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext(phone);
  await ctx.addInitScript(stubSpeechAndPrint);
  return ctx;
}

/** Signs in through the API (the context shares the cookie) and opens a screen, tapping the start button. */
async function openScreen(ctx: BrowserContext, base: string, user: string, pin: string, hash: string): Promise<Page> {
  const login = await ctx.request.post(`${base}/api/login`, { data: { user, pin } });
  expect(login.status()).toBe(200);
  const page = await ctx.newPage();
  await page.goto(`${base}/staff${hash}`);
  await page.getByRole("button", { name: "Tap to start (turns sound on)" }).click();
  return page;
}

const spoken = (page: Page) => page.evaluate(() => window.__spoken);

let keys = 0;
async function apiOrder(base: string, lines: unknown[]): Promise<{ id: string; token: string }> {
  keys++;
  const res = await fetch(`${base}/api/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientKey: `e2e-staff-${keys}-${Date.now()}`, lines }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { order: { id: string; token: string } };
  return body.order;
}

async function openOrders(s: RunningServer): Promise<StaffOrderView[]> {
  return ((await s.staff("GET", "/api/orders")).body as { orders: StaffOrderView[] }).orders;
}

async function addStaff(s: RunningServer, id: string, pin: string, role?: string): Promise<void> {
  expect((await s.staff("PUT", `/api/staff/${id}`, { name: id, pin, ...(role ? { role } : {}) })).status).toBe(200);
}

test("a staged rush: counter, tea and kitchen stations, ten customers, a walk-in, ready, top-up and print", async ({
  browser,
}) => {
  server = await startServer("tea-house", { UPI_VPA: "teahouse@example", UPI_PAYEE_NAME: "The Tea House" });
  const s = server;
  await Promise.all([addStaff(s, "counter-1", "1357"), addStaff(s, "tea-1", "2468"), addStaff(s, "kitchen-1", "3579")]);

  // The counter signs in through the form; the stations through the API.
  const counterCtx = await staffContext(browser);
  const counter = await counterCtx.newPage();
  await counter.goto(`${s.base}/staff`);
  await counter.getByLabel("Staff ID").fill("counter-1");
  await counter.getByLabel("PIN").fill("1357");
  await counter.getByRole("button", { name: "Unlock", exact: true }).click();
  await counter.getByRole("link", { name: "Counter" }).click();
  await expect(counter.getByRole("button", { name: "Pending 0" })).toBeVisible();
  const [tea, kitchen] = await Promise.all([
    openScreen(await staffContext(browser), s.base, "tea-1", "2468", "#/station/tea"),
    openScreen(await staffContext(browser), s.base, "kitchen-1", "3579", "#/station/kitchen"),
  ]);
  await expect(tea.getByTestId("batch-text")).toHaveText("Nothing to prepare");

  // Ten customers: eight through the API, two through the storefront.
  const chai = (size: string, qty: number) => ({ itemId: "house-special-chai", size, qty });
  const plan: unknown[][] = [
    [chai("M", 2)],
    [chai("S", 1), { itemId: "veg-momos-sf", qty: 1 }],
    [{ itemId: "salted-fries", qty: 2 }],
    [chai("M", 1), { itemId: "cold-coffee", qty: 1 }],
    [{ itemId: "veg-momos-sf", qty: 2 }],
    [chai("L", 3)],
    [{ itemId: "lemon-ice-tea", qty: 1 }, chai("M", 1)],
    [{ itemId: "cold-coffee", qty: 2 }],
  ];
  const placed: { id: string; token: string }[] = [];
  for (const lines of plan) placed.push(await apiOrder(s.base, lines));
  const customer = await (await browser.newContext(phone)).newPage();
  for (const label of ["chai", "momos"]) {
    await customer.goto(`${s.base}/`);
    if (label === "chai") await addSized(customer, "House Special Chai", "M");
    else await customer.getByRole("button", { name: "Add Veg Momos S/F" }).click();
    await customer.getByTestId("cart-bar").click();
    await customer.getByRole("button", { name: "Place order" }).click();
    await expect(customer.getByTestId("token")).toHaveText(/^#\d+$/);
  }
  const customerToken = (await customer.getByTestId("token").textContent()) as string;
  await expect(counter.getByRole("button", { name: "Pending 10" })).toBeVisible();

  // The counter confirms cash for two orders (one with the change helper) and UPI for one.
  const card = (token: string) => counter.getByTestId(`order-${token}`);
  const first = card(placed[0]?.token as string);
  await first.getByRole("button", { name: "Cash", exact: true }).click();
  await first.getByRole("button", { name: "₹100" }).click();
  await expect(first.getByTestId("change")).toHaveText("Change due₹40.00");
  await first.getByRole("button", { name: "Cash received: ₹60" }).click();
  await expect(first.getByText("Paid ₹60")).toBeVisible();
  const second = card(placed[1]?.token as string);
  await second.getByRole("button", { name: "Cash", exact: true }).click();
  // The tea house's own shortcuts (5 to 50) cover the ₹80 due with none, so the next notes up are offered.
  await second.getByRole("button", { name: "Cash received: ₹80" }).click();
  await expect(second.getByText("Paid ₹80")).toBeVisible();
  const third = card(placed[2]?.token as string);
  await third.getByRole("button", { name: "UPI received" }).click();
  await expect(third.getByText("Paid ₹120")).toBeVisible();

  // A walk-in at the counter: the quick-order panel, the business's cash shortcuts and the change due.
  await counter.getByRole("button", { name: "New order" }).click();
  await counter.getByRole("button", { name: "Add House Special Chai, size S" }).click();
  await counter.getByRole("button", { name: "Add House Special Chai, size S" }).click();
  await counter.getByRole("button", { name: "Cash", exact: true }).click();
  const tenders = counter.getByRole("group", { name: "Cash handed over" }).getByRole("button");
  await expect(tenders).toHaveText(["₹40", "₹50"]);
  await counter.getByRole("button", { name: "₹50" }).click();
  await expect(counter.getByTestId("change")).toHaveText("Change ₹10.00");
  await counter.getByRole("button", { name: "Cash received: ₹40" }).click();
  await expect(counter.getByRole("button", { name: "Pending 11" })).toBeVisible();

  // Each station shows exactly its own lines; the tea station's batch text is the core's for the same open orders.
  const open = await openOrders(s);
  expect(open).toHaveLength(11);
  const teaText = renderBatch(openBatch(open, "tea"), en);
  const kitchenText = renderBatch(openBatch(open, "kitchen"), en);
  expect(teaText).toMatch(/^Orders .* 5 House Special Chai M, /);
  // The screen groups by item with a row per size, a count and the tokens, and reads the batch in a bar below.
  const chaiGroup = tea.getByTestId("item-house-special-chai");
  await expect(chaiGroup.getByRole("heading", { name: "House Special Chai" })).toBeVisible();
  await expect(chaiGroup.locator(".brows li").first().locator(".count")).toContainText("5");
  await expect(chaiGroup.locator(".brows li").first().locator(".chips i").first()).toHaveText(/^#\d+$/);
  await expect(tea.getByTestId("reading")).toContainText(/^Reading: Orders .* · 5 House Special Chai M, /);
  await expect(tea.getByTestId("batch-text")).toHaveText(teaText);
  await expect(kitchen.getByTestId("batch-text")).toHaveText(kitchenText);
  await expect(kitchen.getByTestId("batch-text")).not.toContainText("Chai");
  // Arrivals are spoken as one batch once the burst settles; replay says exactly the same.
  await expect.poll(async () => (await spoken(tea)).at(-1)).toBe(teaText);
  await tea.getByRole("button", { name: "Replay" }).click();
  await expect.poll(async () => (await spoken(tea)).at(-1)).toBe(teaText);
  expect(await spoken(tea)).not.toContain(kitchenText);

  // Tea marks everything ready: tea-only orders reach the counter's Ready tab, mixed ones wait for the kitchen.
  await tea.getByRole("button", { name: "All ready" }).click();
  await expect(tea.getByTestId("batch-text")).toHaveText("Nothing to prepare");
  await counter.getByRole("button", { name: /^Ready / }).click();
  await expect(card(placed[0]?.token as string)).toBeVisible();
  await expect(card(placed[1]?.token as string)).toHaveCount(0);
  await expect(counter.getByRole("button", { name: "Ready 6" })).toBeVisible();

  // The kitchen marks one batch line ready, then the rest; every order is ready, and so is the customer's page.
  await kitchen.getByTestId("item-salted-fries").getByRole("button", { name: "Ready" }).click();
  await expect(kitchen.getByTestId("batch-text")).not.toContainText("Salted Fries");
  await kitchen.getByRole("button", { name: "All ready" }).click();
  await expect(counter.getByRole("button", { name: "Ready 11" })).toBeVisible();
  await expect(customer.getByTestId("status")).toHaveText("Ready! Please collect it.");
  // A mis-tap is taken back: the counter and the customer's page revert live, then it is marked again.
  await kitchen.getByRole("button", { name: "Undo ready" }).click();
  await expect(kitchen.getByRole("button", { name: "Undo ready" })).toHaveCount(0);
  await expect(customer.getByTestId("status")).toHaveText("Order placed");
  await expect(counter.getByRole("button", { name: "Ready 7" })).toBeVisible();
  await expect(kitchen.getByTestId("batch-text")).not.toHaveText("Nothing to prepare");
  await kitchen.getByRole("button", { name: "All ready" }).click();
  await expect(counter.getByRole("button", { name: "Ready 11" })).toBeVisible();
  await expect(customer.getByTestId("status")).toHaveText("Ready! Please collect it.");
  await expect(customer.getByTestId("token")).toHaveText(customerToken);

  // The counter calls a token out loud.
  await card(placed[0]?.token as string)
    .getByRole("button", { name: "Call order" })
    .click();
  await expect
    .poll(async () => (await spoken(counter)).at(-1))
    .toBe(`Order ${orderNumber(placed[0]?.token as string)}, your order is ready.`);

  // Items added to a paid order: the counter takes the extra amount and the order owes nothing again.
  await card(placed[0]?.token as string)
    .getByRole("button", { name: "Add items" })
    .click();
  await counter.getByRole("button", { name: "Add Salted Fries" }).click();
  await counter
    .getByRole("button", { name: `Add to ${orderNumber(placed[0]?.token as string)}` })
    .last()
    .click();
  // The added line isn't ready, so the order is back with the kitchen and in Pending.
  await counter.getByRole("button", { name: /^Pending / }).click();
  const topped = card(placed[0]?.token as string);
  await expect(topped.getByText("Added items: take ₹60 more")).toBeVisible();
  await expect(kitchen.getByTestId("batch-text")).toHaveText(
    `Orders ${orderNumber(placed[0]?.token ?? "")} 1 Salted Fries`,
  );
  await topped.getByRole("button", { name: "Cash", exact: true }).click();
  await topped.getByRole("button", { name: "Cash received: ₹60" }).click();
  await expect(topped.getByText("Paid ₹120")).toBeVisible();
  const after = (await openOrders(s)).find((o) => o.id === placed[0]?.id);
  expect(after?.outstandingMinor).toBe(0);
  expect(after?.payment).toMatchObject({ state: "confirmed", amountMinor: 12000, topUps: [{ amountMinor: 6000 }] });

  // The kitchen prints its tickets: only the print view shows them, 72mm wide, with the business, token and lines.
  await kitchen.getByRole("button", { name: "Print tickets" }).click();
  expect(await kitchen.evaluate(() => window.__printed)).toBe(1);
  const ticket = kitchen.getByTestId(`ticket-${placed[0]?.token}`);
  await expect(ticket).toBeHidden();
  await kitchen.emulateMedia({ media: "print" });
  await expect(ticket).toBeVisible();
  await expect(kitchen.locator("#app")).toBeHidden();
  await expect(ticket).toContainText("The Tea House");
  await expect(ticket).toContainText(`Order ${orderNumber(placed[0]?.token as string)}`);
  await expect(ticket).toContainText("Kitchen");
  await expect(ticket).toContainText("1 ×Salted Fries");
  const width = await kitchen.locator("#print").evaluate((el) => el.getBoundingClientRect().width);
  expect(Math.round(width)).toBe(272);

  // And the counter prints a receipt with the money in the business's currency.
  await card(placed[0]?.token as string)
    .getByRole("button", { name: "Print receipt" })
    .click();
  await counter.emulateMedia({ media: "print" });
  const receipt = counter.getByTestId(`ticket-${placed[0]?.token}`);
  await expect(receipt).toBeVisible();
  await expect(receipt).toContainText("Total₹120.00");
  await expect(receipt).toContainText("Paid₹120.00");
});

test("a walk-in paying by UPI sees a QR for the exact total, and the cart can't change once it shows", async ({
  browser,
}) => {
  server = await startServer("tea-house", { UPI_VPA: "teahouse@example", UPI_PAYEE_NAME: "The Tea House" });
  const counter = await openScreen(await staffContext(browser), server.base, "owner", OWNER_PIN, "#/counter");
  await counter.getByRole("button", { name: "New order" }).click();
  await counter.getByRole("button", { name: "Add House Special Chai, size M" }).click();
  await counter.getByRole("button", { name: "One more House Special Chai (M)" }).click();
  await counter.getByRole("button", { name: "UPI QR" }).click();
  await expect(counter.getByRole("img", { name: "UPI QR code for ₹60" })).toBeVisible();
  await expect(counter.getByRole("button", { name: /^One (more|less) / })).toHaveCount(0);
  await counter.getByRole("button", { name: "UPI received" }).click();
  await expect(counter.getByText("Paid ₹60")).toBeVisible();
  const open = await openOrders(server);
  expect(open).toHaveLength(1);
  expect(open[0]?.payment).toMatchObject({ state: "confirmed", method: "upi", amountMinor: 6000 });
});

test("a jobs station shows one card per customer's job, speaks each arrival and prints its ticket", async ({
  browser,
}) => {
  server = await startServer("service-desk");
  const s = server;
  await addStaff(s, "bench-1", "2468", "station");
  const bench = await openScreen(await staffContext(browser), s.base, "bench-1", "2468", "#/station/workshop");
  await expect(bench.getByText("No jobs waiting.")).toBeVisible();

  const a = await apiOrder(s.base, [
    { itemId: "screen-replacement", size: "Standard", qty: 1 },
    { itemId: "phone-cleaning", qty: 1 },
  ]);
  const b = await apiOrder(s.base, [
    { itemId: "water-damage-check", qty: 1 },
    { itemId: "battery-replacement", size: "Express", qty: 1 },
  ]);
  const jobA = bench.getByTestId(`job-${a.token}`);
  const jobB = bench.getByTestId(`job-${b.token}`);
  await expect(jobA.getByRole("listitem")).toHaveText(["1 × Screen Replacement (Standard)Ready"]);
  await expect(jobB.getByRole("listitem")).toHaveCount(2);
  await expect
    .poll(() => spoken(bench))
    .toEqual([
      `New job, order ${orderNumber(a.token)}: 1 × Screen Replacement (Standard)`,
      `New job, order ${orderNumber(b.token)}: 1 × Water Damage Check, 1 × Battery Replacement (Express)`,
    ]);

  await jobB.getByRole("button", { name: "Print ticket" }).click();
  await bench.emulateMedia({ media: "print" });
  const ticket = bench.getByTestId(`ticket-${b.token}`);
  await expect(ticket).toContainText("Fix-It Counter");
  await expect(ticket).toContainText("Workshop");
  await expect(ticket).toContainText("1 ×Battery Replacement (Express)");
  await bench.emulateMedia({ media: "screen" });

  await jobA.getByRole("button", { name: "Job ready" }).click();
  await expect(jobA).toHaveCount(0);
  await expect(jobB).toBeVisible();
  const order = (await openOrders(s)).find((o) => o.id === a.id);
  expect(order?.lines.map((l) => l.ready)).toEqual([true, false]);

  // The counter sees the job's money in the business's own currency.
  // Station staff see only the stations; the counter needs a counter role (here the owner's).
  await bench.goto(`${s.base}/staff#/`);
  await expect(bench.getByRole("link", { name: "Workshop" })).toBeVisible();
  await expect(bench.getByRole("link", { name: "Counter", exact: true })).toHaveCount(0);
  const counter = await openScreen(await staffContext(browser), s.base, "owner", OWNER_PIN, "#/counter");
  await expect(counter.getByTestId(`order-${a.token}`)).toContainText("Due AED 475");
});
