/**
 * M5: the owner's dashboard against the real server. Sign in with the owner PIN, read today's summary, numbers, chart
 * and forecast, follow the order tabs live, switch an item off and watch an open storefront drop it, add a staff
 * member, and read a review. The numbers themselves are checked against hand counts in tests/insights-checkpoint.
 */

import { expect, test } from "@playwright/test";
import { OWNER_PIN, type RunningServer, startServer } from "./server.ts";

let server: RunningServer | undefined;
test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

const phone = { isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } };
let keyN = 0;

async function order(base: string, lines: unknown[], customerName?: string): Promise<{ id: string; key: string }> {
  keyN++;
  const res = await fetch(`${base}/api/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientKey: `owner-e2e-key-${keyN}-abcdef`,
      lines,
      ...(customerName ? { customerName } : {}),
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { order: { id: string }; key: string };
  return { id: body.order.id, key: body.key };
}

test("the owner signs in, reads today, follows orders live, switches an item off, adds staff and reads reviews", async ({
  browser,
}) => {
  server = await startServer("tea-house");
  const s = server;
  const chai = { itemId: "house-special-chai", size: "M", qty: 2 };
  const soda = { itemId: "masala-soda", qty: 1 };
  await order(s.base, [chai], "Asha");
  await order(s.base, [soda]);
  const done = await order(s.base, [chai, soda]);
  const cash = await s.staff("POST", `/api/orders/${done.id}/confirm`, { method: "cash", amountMinor: 9000 });
  expect(cash.status).toBe(200);
  for (let i = 0; i < 2; i++) expect((await s.staff("POST", `/api/orders/${done.id}/advance`)).status).toBe(200);
  const review = await fetch(`${s.base}/api/orders/${done.id}/review`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-order-key": done.key },
    body: JSON.stringify({ rating: 4, text: "Quick and hot" }),
  });
  expect(review.status).toBe(201);

  const page = await (await browser.newContext(phone)).newPage();
  const errors: string[] = [];
  page.on("console", (m) => {
    // The 401 is the "am I signed in?" check before the PIN, which is how the page knows to ask for it.
    if (m.type() === "error" && !m.text().includes("status of 401")) errors.push(m.text());
  });
  await page.goto(`${s.base}/owner`);
  await page.getByLabel("Owner PIN").fill(OWNER_PIN);
  await page.getByRole("button", { name: "Unlock dashboard" }).click();

  // Today: 3 orders, 2×3000 + 3000 + 2×3000 + 3000 = 18000 paise ordered.
  const summary = page.getByTestId("summary");
  // Only the confirmed ₹90 is received; the two unpaid orders are awaiting.
  await expect(summary).toContainText(
    "3 orders so far, worth ₹180. Received (confirmed by staff): ₹90. 2 orders, ₹90, still awaiting payment confirmation.",
  );
  await expect(page.getByTestId("stat-received")).toContainText("₹90");
  await expect(summary).toContainText("Most ordered: House Special Chai, 4 sold.");
  await expect(page.getByTestId("stat-orders")).toContainText("3");
  await expect(page.locator("svg.chart rect.bar.peak")).toHaveCount(1);
  await expect(page.locator("svg.chart rect.bar.peak")).toHaveAttribute("data-orders", "3");
  await expect(page.getByTestId("forecast")).toContainText("mean of the last 7 days with orders");
  await expect(page.getByTestId("forecast")).toContainText("4 × House Special Chai M");

  // Orders: the tabs count every status; a new order arrives live in Pending.
  await page.getByRole("link", { name: "Orders" }).click();
  await expect(page.getByRole("button", { name: "Pending 2" })).toBeVisible();
  await page.getByRole("button", { name: "Completed 1" }).click();
  await expect(page.locator("article.order-card")).toHaveCount(1);
  await expect(page.getByTestId("payment")).toHaveText("Paid ₹90");
  await page.getByRole("button", { name: "Pending 2" }).click();
  await expect(page.getByText("Asha")).toBeVisible();
  await expect(page.locator("article.order-card", { hasText: "Asha" }).getByTestId("payment")).toHaveText("Not paid");
  await order(s.base, [soda], "Ravi");
  await expect(page.getByRole("button", { name: "Pending 3" })).toBeVisible();
  await expect(page.getByText("Ravi")).toBeVisible();

  // Items: switching Masala Soda off takes it off an open storefront menu on its next catalog read.
  const shop = await (await browser.newContext(phone)).newPage();
  await shop.goto(`${s.base}/?catalog=2`);
  const add = shop.getByRole("button", { name: "Add Masala Soda" });
  await expect(add).toBeVisible();
  await page.getByRole("link", { name: "Items" }).click();
  const sw = page.getByRole("switch", { name: "Masala Soda: available" });
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await expect(add).toHaveCount(0, { timeout: 8000 });
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await expect(add).toBeVisible({ timeout: 8000 });

  // Staff: add a station member through the staff API.
  await page.getByRole("link", { name: "Staff" }).click();
  await page.getByLabel("Staff ID").fill("tea-1");
  await page.getByLabel("Name").fill("Meera");
  await page.getByLabel("New PIN (4 to 12 digits)").fill("2468");
  await page.getByLabel("Role").selectOption("station");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("staff-list")).toContainText("Meera (tea-1) · Stations only");

  // Reviews.
  await page.getByRole("link", { name: "Reviews" }).click();
  await expect(page.getByText("4 out of 5 from the latest review")).toBeVisible();
  await expect(page.getByText("Quick and hot")).toBeVisible();
  expect(errors).toEqual([]);
});

test("the owner's tabs are chips: padded, bordered, not underlined, and the current one doesn't overlap the others", async ({
  browser,
}) => {
  server = await startServer("tea-house");
  const page = await (await browser.newContext(phone)).newPage();
  await page.goto(`${server.base}/owner`);
  await page.getByLabel("Owner PIN").fill(OWNER_PIN);
  await page.getByRole("button", { name: "Unlock dashboard" }).click();
  const tabs = page.locator("nav.owner-nav a.chip");
  await expect(tabs.first()).toHaveAttribute("aria-current", "page");
  const looks = await tabs.evaluateAll((els) =>
    els.map((el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        underline: s.textDecorationLine,
        padLeft: Number.parseFloat(s.paddingLeft),
        border: Number.parseFloat(s.borderTopWidth),
        left: r.left,
        right: r.right,
        height: r.height,
        fits: el.scrollWidth <= el.clientWidth,
      };
    }),
  );
  expect(looks).toHaveLength(6);
  for (const [i, l] of looks.entries()) {
    expect(l.underline, `tab ${i}`).toBe("none");
    expect(l.padLeft, `tab ${i}`).toBeGreaterThanOrEqual(8);
    expect(l.border, `tab ${i}`).toBeGreaterThanOrEqual(1);
    expect(l.height, `tab ${i}`).toBeGreaterThanOrEqual(40);
    expect(l.fits, `tab ${i}`).toBe(true);
    if (i > 0) expect(l.left, `tab ${i}`).toBeGreaterThan((looks[i - 1] as { right: number }).right);
  }
});

test("the PIN screen: dots fill as digits are tapped, a subtitle, Unlock, no empty error bar, a real input underneath", async ({
  browser,
}) => {
  server = await startServer("tea-house");
  const page = await (await browser.newContext(phone)).newPage();
  await page.goto(`${server.base}/owner`);
  await expect(page.getByText("Enter your PIN to open the dashboard")).toBeVisible();
  const dots = page.locator(".pdots i");
  await expect(dots).toHaveCount(4);
  await expect(page.locator(".pdots i.f")).toHaveCount(0);
  await page.getByRole("button", { name: "1", exact: true }).click();
  await page.getByRole("button", { name: "2", exact: true }).click();
  await expect(page.locator(".pdots i.f")).toHaveCount(2);
  await expect(dots.first()).toBeVisible();
  // The accessible field is the same one the dots mirror.
  await expect(page.getByLabel("Owner PIN")).toHaveValue("12");
  await expect(page.getByRole("button", { name: "Unlock dashboard" })).toBeVisible();
  // Nothing went wrong yet, so there is no message and no bar where it would go.
  await expect(page.locator(".pin-screen .error")).toBeHidden();
  // A real install shows no demo note.
  await expect(page.getByRole("note")).toHaveCount(0);
});

test("the dashboard header carries the business-zone date, and the average is a whole amount", async ({ browser }) => {
  server = await startServer("tea-house");
  await order(server.base, [{ itemId: "house-special-chai", size: "M", qty: 1 }]);
  await order(server.base, [{ itemId: "house-special-chai", size: "S", qty: 1 }]);
  const page = await (await browser.newContext({ ...phone, locale: "en-US" })).newPage();
  await page.goto(`${server.base}/owner`);
  await page.getByLabel("Owner PIN").fill(OWNER_PIN);
  await page.getByRole("button", { name: "Unlock dashboard" }).click();
  const zone = "Asia/Kolkata";
  const day = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: zone,
  }).format(Date.now());
  await expect(page.locator("header.hdr .brand p")).toHaveText(`Owner dashboard · ${day}`);
  // Two orders, ₹30 and ₹20 is ₹25 on average; a whole amount shows no minor digits.
  await expect(page.getByText(/2 orders · average ₹25$/)).toBeVisible();
});
