/**
 * M12: each level signs in with its own PIN at the links hub and sees exactly its links; a switch the owner flips reaches
 * an open storefront without a reload and appears in the audit; the admin's health page answers on a phone.
 */

import { expect, type Page, test } from "@playwright/test";
import { hashPin } from "../src/server/auth.ts";
import { OWNER_PIN, type RunningServer, startServer } from "./server.ts";

const ADMIN_PIN = "445566";
const phone = { isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } };

let server: RunningServer | undefined;
test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function signIn(page: Page, level: string, pin: string, id?: string): Promise<void> {
  await page.getByTestId(`level-${level}`).click();
  if (id !== undefined) await page.getByLabel("Staff ID").fill(id);
  await page.getByLabel("PIN").fill(pin);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("each level signs in at /admin and sees exactly its links and powers", async ({ browser }) => {
  server = await startServer("garden-cafe", { ADMIN_PIN_HASH: await hashPin(ADMIN_PIN) });
  expect((await server.staff("PUT", "/api/staff/mgr", { name: "Manager", pin: "3344", role: "manager" })).status).toBe(
    200,
  );
  expect((await server.staff("PUT", "/api/staff/till", { name: "Till", pin: "5566", role: "counter" })).status).toBe(
    200,
  );
  const page = await (await browser.newContext(phone)).newPage();
  await page.goto(`${server.base}/admin`);

  // Signed out: the sign-in choices and the public links, nothing else.
  for (const level of ["staff", "manager", "owner", "admin"])
    await expect(page.getByTestId(`level-${level}`)).toBeVisible();
  await expect(page.getByTestId("link-storefront")).toBeVisible();
  await expect(page.getByTestId("link-counter")).toHaveCount(0);

  const links = async () =>
    (
      await page.locator("[data-testid^=link-]").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")))
    ).sort();
  const signOut = async () => {
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByTestId("level-staff")).toBeVisible();
  };

  await signIn(page, "staff", "5566", "till");
  await expect(page.getByTestId("link-counter")).toBeVisible();
  expect(await links()).toEqual(
    [
      "link-counter",
      "link-kiosk",
      "link-runner",
      "link-rooms",
      "link-station-bar",
      "link-station-cakes",
      "link-station-kitchen",
      "link-station-smoothies",
      "link-storefront",
    ].sort(),
  );
  await signOut();

  await signIn(page, "manager", "3344", "mgr");
  await expect(page.getByTestId("link-manager")).toBeVisible();
  await expect(page.getByTestId("link-owner-today")).toHaveCount(0);
  await signOut();

  // A staff ID cannot pass for a manager.
  await signIn(page, "manager", "5566", "till");
  await expect(page.getByRole("alert")).toContainText("not a Manager");
  await page.goto(`${server.base}/admin`);

  await signIn(page, "owner", OWNER_PIN);
  await expect(page.getByTestId("link-owner-appearance")).toBeVisible();
  await expect(page.getByTestId("link-owner-spots")).toBeVisible();
  await expect(page.getByTestId("link-health")).toHaveCount(0);
  await expect(page.getByTestId("link-system-switches")).toHaveCount(0);
  await signOut();

  await signIn(page, "admin", ADMIN_PIN);
  expect(await links()).toEqual(["link-health", "link-kiosk", "link-storefront", "link-system-switches"]);
  await page.getByTestId("link-health").click();
  await expect(page.getByTestId("verdict")).toContainText("Healthy");
  await expect(page.getByTestId("stat-requests")).toBeVisible();
  await expect(page.getByTestId("stat-rows")).toContainText("100,000");
  // On a phone the page does not scroll sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("a switch the owner flips reaches an open storefront without a reload, and the audit shows it", async ({
  browser,
}) => {
  server = await startServer("tea-house", { ADMIN_PIN_HASH: await hashPin(ADMIN_PIN) });
  const store = await (await browser.newContext(phone)).newPage();
  await store.goto(`${server.base}/`);
  const dark = store.getByRole("button", { name: "Dark mode" });
  await expect(dark).toBeVisible();
  await store.evaluate(() => {
    (window as unknown as { stayed: boolean }).stayed = true;
  });

  const flip = await server.staff("PUT", "/api/flags/features.darkToggle", { value: false });
  expect(flip.status).toBe(200);
  // The storefront looks for a new look when it comes back into view, and every half minute.
  await store.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(dark).toHaveCount(0);
  expect(await store.evaluate(() => (window as unknown as { stayed?: boolean }).stayed)).toBe(true);

  const owner = await (await browser.newContext(phone)).newPage();
  await owner.goto(`${server.base}/admin#/switches`);
  await signIn(owner, "owner", OWNER_PIN);
  await owner.goto(`${server.base}/admin#/switches`);
  await expect(owner.getByTestId("audit")).toContainText("owner changed features.darkToggle from On to Off");
  // The admin has the system switches and not the look's.
  const admin = await (await browser.newContext(phone)).newPage();
  await admin.goto(`${server.base}/admin#/switches`);
  await signIn(admin, "admin", ADMIN_PIN);
  await admin.goto(`${server.base}/admin#/switches`);
  await expect(admin.getByTestId("flag-retentionDays")).toBeVisible();
  await expect(admin.getByTestId("flag-features.darkToggle")).toHaveCount(0);
  await admin.getByTestId("flag-showcase").click();
  await expect(admin.getByTestId("audit")).toContainText("admin changed showcase from Off to On");
  expect((await fetch(`${server.base}/showcase`)).status).toBe(200);
});
