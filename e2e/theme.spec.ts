/**
 * M8: the look is a theme, not code. A custom theme from the config renders (colours, typeface, header, logo image,
 * relabelled text) through the same bundles the default look uses, and a change made on the owner's Appearance screen
 * reaches an open storefront without a reload.
 */

import { expect, type Page, test } from "@playwright/test";
import { OWNER_PIN, type RunningServer, startServer } from "./server.ts";

let server: RunningServer | undefined;
test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

const phone = { isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } };
const token = (page: Page, name: string) =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

test("the default look is the approved green and yellow with the awning", async ({ browser }) => {
  server = await startServer("tea-house");
  const page = await (await browser.newContext(phone)).newPage();
  await page.goto(`${server.base}/`);
  await expect(page.locator(".awning")).toBeVisible();
  expect(await token(page, "--primary")).toBe("#2d5a27");
  expect(await token(page, "--accent")).toBe("#f5c518");
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain("ibow-inter");
});

test("a coffee cart's theme from its config renders: colours, serif, plain header, descriptions", async ({
  browser,
}) => {
  server = await startServer("coffee-cart");
  const page = await (await browser.newContext(phone)).newPage();
  await page.goto(`${server.base}/`);
  await expect(page.locator(".item").first()).toBeVisible();
  expect(await token(page, "--primary")).toBe("#c8864b");
  expect(await token(page, "--r-card")).toBe("12px");
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain("ibow-lora");
  await expect(page.locator(".awning")).toHaveCount(0);
  await expect(page.locator("header.hdr")).toHaveAttribute("data-style", "plain");
  await expect(page.getByText("A short, strong shot pulled to order.")).toBeVisible();
  // The font file is the bundled one, served from this server.
  await expect.poll(() => page.evaluate(() => document.fonts.check('14px "ibow-lora"'))).toBe(true);
});

test("a service desk's theme: square blue, a logo image from the config folder, its own words", async ({ browser }) => {
  server = await startServer("service-desk");
  const page = await (await browser.newContext(phone)).newPage();
  await page.goto(`${server.base}/`);
  await expect(page.locator(".item").first()).toBeVisible();
  expect(await token(page, "--primary")).toBe("#1d5fd1");
  expect(await token(page, "--r-card")).toBe("2px");
  await expect(page.getByText("Request a service, follow it with your ticket")).toBeVisible();
  const logo = page.locator(".logo img");
  await expect(logo).toHaveAttribute("src", "/media/logo.svg");
  await expect.poll(() => logo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  // Another page of the same install uses the same sheet, and the favourites toggle is off in this theme.
  await expect(page.locator(".fav")).toHaveCount(0);
  await page.getByRole("button", { name: /^Add / }).first().click();
  if ((await page.getByTestId("sheet-add").count()) > 0) await page.getByTestId("sheet-add").click();
  await page.getByTestId("cart-bar").click();
  await expect(page.getByRole("button", { name: /^Submit request/ })).toBeVisible();
});

test("an Appearance change reaches an open storefront without a reload, warns about unreadable colours, and resets", async ({
  browser,
}) => {
  server = await startServer("tea-house");
  const customer = await (await browser.newContext(phone)).newPage();
  await customer.goto(`${server.base}/`);
  await expect(customer.locator(".item").first()).toBeVisible();
  await customer.evaluate(() => {
    (window as unknown as { __kept: boolean }).__kept = true;
  });
  expect(await token(customer, "--accent")).toBe("#f5c518");

  const owner = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await owner.goto(`${server.base}/owner`);
  await owner.getByLabel("Owner PIN").fill(OWNER_PIN);
  await owner.getByRole("button", { name: "Unlock dashboard" }).click();
  await owner.getByRole("link", { name: "Appearance" }).click();
  await expect(owner.locator(".preview")).toBeVisible();

  // The preview follows the controls at once.
  await owner.getByLabel("Accent (highlights)").fill("#ff0000");
  expect(await owner.locator(".preview").evaluate((el) => (el as HTMLElement).style.getPropertyValue("--accent"))).toBe(
    "#ff0000",
  );
  await owner.getByLabel("Typeface").selectOption("lora");
  await expect(owner.getByTestId("contrast-ok")).toBeVisible();

  // Unreadable text is warned about, and the first press of Save only warns.
  await owner.getByLabel("Text, light mode").fill("#cccccc");
  await expect(owner.getByTestId("contrast-bad")).toContainText("Text on the page, light mode");
  const save = owner.getByRole("button", { name: "Save anyway" });
  await save.click();
  await expect(owner.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  await owner.getByLabel("Text, light mode").fill("#151a14");
  await expect(owner.getByTestId("contrast-ok")).toBeVisible();

  await owner.getByRole("button", { name: "Save", exact: true }).click();
  await expect(owner.getByText("Saved. Open screens update within half a minute.")).toBeVisible();

  // The open storefront swaps its sheet when it next looks (here: when it becomes visible), with no reload.
  await customer.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => token(customer, "--accent")).toBe("#ff0000");
  expect(await customer.evaluate(() => (window as unknown as { __kept?: boolean }).__kept)).toBe(true);
  // A fresh load gets the saved look and typeface too.
  const fresh = await (await browser.newContext(phone)).newPage();
  await fresh.goto(`${server.base}/`);
  expect(await token(fresh, "--accent")).toBe("#ff0000");
  expect(await fresh.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain("ibow-lora");

  // Reset to config brings the approved look back.
  await owner.getByRole("button", { name: "Reset to config" }).click();
  await expect(owner.getByText("Back to the look in the config.")).toBeVisible();
  await customer.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => token(customer, "--accent")).toBe("#f5c518");
});

/** WCAG contrast of an element's text against the first opaque background behind it, computed in the page. */
async function contrastOf(page: Page, selector: string): Promise<{ selector: string; text: string; ratio: number }[]> {
  return page.evaluate((sel) => {
    const parse = (c: string): [number, number, number, number] => {
      const m = c.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 1];
      return [m[0] ?? 0, m[1] ?? 0, m[2] ?? 0, m[3] ?? 1];
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => {
        const s = (v as number) / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r as number) + 0.7152 * f(g as number) + 0.0722 * f(b as number);
    };
    const backdrop = (el: Element): number[] => {
      for (let n: Element | null = el; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c[3] === 1) return c;
        if (c[3] > 0.5) return c;
      }
      return [255, 255, 255, 1];
    };
    return [...document.querySelectorAll(sel)].slice(0, 6).map((el) => {
      const fg = parse(getComputedStyle(el).color);
      const bg = backdrop(el);
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a) as [number, number];
      return { selector: sel, text: (el.textContent ?? "").trim().slice(0, 24), ratio: (hi + 0.05) / (lo + 0.05) };
    });
  }, selector);
}

for (const [sample, mode] of [
  ["tea-house", "light"],
  ["tea-house", "dark"],
  ["coffee-cart", "light"],
  ["coffee-cart", "dark"],
  ["service-desk", "light"],
  ["service-desk", "dark"],
] as const) {
  test(`key text reads at 4.5:1 or better on the rendered storefront: ${sample}, ${mode}`, async ({ browser }) => {
    server = await startServer(sample);
    const ctx = await browser.newContext({ ...phone, colorScheme: mode });
    const page = await ctx.newPage();
    await page.goto(`${server.base}/`);
    await expect(page.locator(".item").first()).toBeVisible();
    for (const selector of [
      ".item h3",
      ".price",
      ".desc",
      ".sec small",
      ".tab",
      ".tab[aria-current=page]",
      ".tag",
      ".pill",
      ".qc small",
      ".qc b",
    ]) {
      for (const r of await contrastOf(page, selector)) {
        expect(r.ratio, `${sample} ${mode} ${selector} "${r.text}"`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
}
