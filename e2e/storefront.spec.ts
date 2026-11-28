/**
 * M3 checkpoint: a customer places, edits, pays and tracks an order to "ready" in a real browser against the real
 * server; a kiosk takes an order and resets with nothing of it left.
 */

import { expect, test } from "@playwright/test";
import { orderNumber } from "../src/core/tokens.ts";
import { addSized } from "./helpers.ts";
import { type RunningServer, startServer } from "./server.ts";

interface StaffOrder {
  id: string;
  token: string;
  customerName?: string;
  totalMinor: number;
  payment: { state: string };
  lines: { itemId: string; size?: string; qty: number }[];
}

let server: RunningServer | undefined;
test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

const phone = { isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } };

test("a customer orders a size with a name, edits in the window, pays by UPI and watches it go live to ready", async ({
  browser,
}) => {
  server = await startServer("tea-house", { UPI_VPA: "teahouse@example", UPI_PAYEE_NAME: "The Tea House" });
  const page = await (await browser.newContext(phone)).newPage();
  const polls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/poll/")) polls.push(r.url());
  });
  await page.goto(`${server.base}/`);

  await page.getByRole("searchbox").fill("special chai");
  // An item with sizes opens a sheet: pick the size, then add.
  await page.getByRole("button", { name: "Add House Special Chai" }).click();
  await page.getByRole("radio", { name: /^M/ }).click();
  await page.getByTestId("sheet-add").click();
  const cartBar = page.getByTestId("cart-bar");
  await expect(cartBar).toContainText("₹30");
  await cartBar.click();
  await page.getByLabel("What's your name?").fill("Asha");
  const stream = page.waitForRequest(/\/api\/stream\/order\//);
  await page.getByRole("button", { name: "Place order" }).click();

  const token = page.getByTestId("token");
  const status = page.getByTestId("status");
  await expect(token).toHaveText("#1");
  const tokenText = (await token.getAttribute("data-token")) as string;
  // The "#" is small and the number large, both painted: the number's gradient text would swallow a prefix that
  // is its own layer (opacity) or transparent, so the prefix must carry its own opaque fill.
  const prefix = token.locator("small");
  await expect(prefix).toHaveText("#");
  const painted = await prefix.evaluate((el) => {
    const c = getComputedStyle(el);
    return { opacity: c.opacity, fill: c.webkitTextFillColor, size: Number.parseFloat(c.fontSize) };
  });
  const numberSize = await token.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
  expect(painted.opacity).toBe("1");
  expect(painted.fill).not.toMatch(/rgba\(\d+, \d+, \d+, 0\)|transparent/);
  expect(painted.size).toBeLessThan(numberSize / 2);
  await expect(status).toHaveText("Order placed");
  await expect(page.getByTestId("order-name")).toHaveText("Asha");
  const upi = page.getByRole("link", { name: "Open a UPI app" });
  await expect(upi).toHaveAttribute(
    "href",
    `upi://pay?pa=teahouse@example&pn=The%20Tea%20House&am=30&cu=INR&tn=Token%20${tokenText}`,
  );
  await expect(page.getByRole("img", { name: "UPI QR code for ₹30" })).toBeVisible();
  // The order key travels in a header, never in a URL the page shows.
  expect(page.url()).not.toContain("key=");
  expect(await page.evaluate(() => sessionStorage.getItem("ibow.order"))).toMatch(/"key":/);

  // Edit within the 2-minute window, before claiming payment: a claimed payment ends edits (D-007).
  await page.getByRole("button", { name: /^Change order \(\d:\d\d left\)$/ }).click();
  await expect(page.getByText(`Changing order ${orderNumber(tokenText)}.`)).toBeVisible();
  await page.getByRole("searchbox").fill("momos");
  await page.getByRole("button", { name: "Add Veg Momos S/F" }).click();
  await cartBar.click();
  await page.getByRole("button", { name: "Update order" }).click();
  await expect(upi).toHaveAttribute("href", /&am=90&/);

  await page.getByRole("button", { name: "I've paid" }).click();
  await expect(page.getByText("You said you paid ₹90. Staff will check it.")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Change order/ })).toHaveCount(0);

  const open = (await server.staff("GET", "/api/orders")).body as { orders: StaffOrder[] };
  const order = open.orders[0] as StaffOrder;
  expect(order).toMatchObject({
    token: tokenText,
    customerName: "Asha",
    totalMinor: 9000,
    payment: { state: "claimed" },
    lines: [
      { itemId: "house-special-chai", size: "M", qty: 1 },
      { itemId: "veg-momos-sf", qty: 1 },
    ],
  });

  await stream;
  expect((await server.staff("POST", `/api/orders/${order.id}/advance`)).status).toBe(200);
  await expect(status).toHaveText("Being prepared");
  await server.staff("POST", `/api/orders/${order.id}/confirm`, { method: "upi", amountMinor: 9000 });
  await expect(page.getByText("Paid. Thank you!")).toBeVisible();
  await server.staff("POST", `/api/orders/${order.id}/advance`);
  await expect(status).toHaveText("Ready! Please collect it.");
  expect(polls, "updates came over SSE, not polling").toEqual([]);

  const fourStars = page.getByRole("button", { name: "4 out of 5" });
  await fourStars.click();
  await expect(fourStars).toBeFocused();
  await expect(fourStars).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("status")).toHaveCount(1);
  await page.getByLabel("Anything to add? (optional)").fill("Quick and hot");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Thanks for your review!")).toBeVisible();

  await page.getByRole("link", { name: "Find my order" }).click();
  await page.getByLabel("Order number").fill(tokenText);
  await page.getByRole("button", { name: "Check" }).click();
  await expect(page.getByRole("status")).toContainText("Ready! Please collect it.");
});

test("when the stream is blocked, the token page falls back to polling and still goes live", async ({ browser }) => {
  server = await startServer("tea-house");
  const page = await (await browser.newContext(phone)).newPage();
  await page.route("**/api/stream/**", (route) => route.fulfill({ status: 503, body: "" }));
  const polled = page.waitForRequest(/\/api\/poll\/order\//);
  await page.goto(`${server.base}/`);
  await page.getByRole("button", { name: "Add Veg Momos S/F" }).click();
  await page.getByTestId("cart-bar").click();
  await page.getByRole("button", { name: "Place order" }).click();
  // No UPI set up: only pay at the counter.
  await expect(page.getByText("Please pay ₹60 at the counter.")).toBeVisible();
  await expect(page.getByRole("button", { name: "I've paid" })).toHaveCount(0);
  await polled;
  const order = ((await server.staff("GET", "/api/orders")).body as { orders: StaffOrder[] }).orders[0] as StaffOrder;
  await server.staff("POST", `/api/orders/${order.id}/advance`);
  await expect(page.getByTestId("status")).toHaveText("Being prepared");
});

test("kiosk mode takes an order without a name, shows the token big, then resets with nothing left", async ({
  page,
}) => {
  server = await startServer("coffee-cart");
  await page.goto(`${server.base}/?kiosk=1&reset=3`);
  await expect(page.locator("body")).toHaveClass(/kiosk/);
  await expect(page.getByRole("link", { name: "Find my order" })).toHaveCount(0);

  await addSized(page, "Espresso", "S");
  const cartBar = page.getByTestId("cart-bar");
  await expect(cartBar).toContainText("$3");
  await cartBar.click();
  await expect(page.getByLabel("What's your name?")).toHaveCount(0);
  await page.getByRole("button", { name: "Place order" }).click();

  const token = page.getByTestId("token");
  await expect(token).toHaveText("#1");
  await expect(token).toHaveClass(/huge/);
  await expect(page.getByText("Please pay $3 at the counter.")).toBeVisible();
  await expect(page.getByRole("img", { name: /UPI/ })).toHaveCount(0);

  await expect(token).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByRole("searchbox")).toBeVisible();
  await expect(cartBar).toHaveCount(0);
  await expect(page.getByText(/\d{2}-001/)).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.length + localStorage.length)).toBe(0);
  // Back after a reset reaches no previous order: the old page's state lived only in memory.
  await page.goBack();
  await expect(page.getByRole("searchbox")).toBeVisible();
  await expect(token).toHaveCount(0);
  await expect(cartBar).toHaveCount(0);
  await expect(page.getByText(/\d{2}-001/)).toHaveCount(0);
  await page.goto(`${server.base}/?kiosk=1&reset=3`);

  await addSized(page, "Latte", "M");
  await cartBar.click();
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(token).toHaveText("#2");
});

test("a kiosk left mid-order resets after the idle time, and back doesn't bring the cart back", async ({ page }) => {
  server = await startServer("coffee-cart");
  await page.goto(`${server.base}/?kiosk=1&idle=2`);
  await addSized(page, "Espresso", "S");
  const cartBar = page.getByTestId("cart-bar");
  await cartBar.click();
  await expect(page.getByRole("button", { name: "Place order" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Place order" })).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByRole("searchbox")).toBeVisible();
  await expect(cartBar).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole("searchbox")).toBeVisible();
  await expect(cartBar).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Place order" })).toHaveCount(0);
});

test("under counter-first with UPI on, a guest who says they paid is told the kitchen starts once the counter confirms", async ({
  browser,
}) => {
  server = await startServer("tea-house", { UPI_VPA: "teahouse@example", UPI_PAYEE_NAME: "The Tea House" });
  expect((await server.staff("PUT", "/api/flags/ops.counterFirst", { value: true })).status).toBe(200);
  const page = await (await browser.newContext(phone)).newPage();
  await page.goto(`${server.base}/`);
  await page.getByRole("button", { name: "Add Veg Momos S/F" }).click();
  await page.getByTestId("cart-bar").click();
  await page.getByRole("button", { name: "Place order" }).click();
  await page.getByRole("button", { name: "I've paid" }).click();
  await expect(page.getByText("You said you paid ₹60. Staff will check it.")).toBeVisible();
  await expect(page.getByTestId("claimed-first")).toHaveText(
    "The kitchen starts once the counter confirms your payment.",
  );
});
