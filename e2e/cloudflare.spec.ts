/**
 * M9: the Worker and its Durable Object in workerd (Miniflare) as a visitor meets them. A demo install shows its
 * throwaway PINs on the staff and owner sign-in screens and they work; a real install shows none.
 */

import { expect, test } from "@playwright/test";
import { hashPin } from "../src/server/auth.ts";
import { type RunningWorker, startWorker } from "../tests/support/worker.ts";

const phone = { isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } };
let worker: RunningWorker | undefined;
test.afterEach(async () => {
  await worker?.stop();
  worker = undefined;
});

test("a demo install shows the PINs, and they sign in as the counter and as the owner", async ({ browser }) => {
  test.setTimeout(180_000); // the demo seeds itself over several alarms first
  worker = await startWorker({ env: { DEMO: "1" } });
  const demo = (await (await fetch(`${worker.base}/api/demo`)).json()) as {
    staff: { id: string; pin: string }[];
    owner: { pin: string };
  };
  const counter = demo.staff.find((s) => s.id === "counter") as { id: string; pin: string };
  const context = await browser.newContext(phone);
  const page = await context.newPage();

  await page.goto(`${worker.base}/staff`);
  await expect(page.getByRole("note")).toContainText(`ID counter, PIN ${counter.pin}`);
  await page.getByLabel("Staff ID").fill(counter.id);
  await page.getByLabel("PIN").fill(counter.pin);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Choose a screen" })).toBeVisible();

  await page.goto(`${worker.base}/owner`);
  await expect(page.getByRole("note")).toContainText(demo.owner.pin);
  await page.getByLabel("Owner PIN").fill(demo.owner.pin);
  await page.getByRole("button", { name: "Unlock dashboard" }).click();
  await expect(page.getByLabel("Owner PIN")).toBeHidden();
  await context.close();
});

test("a real install shows no PIN on any sign-in screen", async ({ browser }) => {
  worker = await startWorker({ env: { OWNER_PIN_HASH: await hashPin("908172", 1024) } });
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  for (const path of ["/staff", "/owner"]) {
    await page.goto(worker.base + path);
    await expect(page.getByRole("button", { name: /^Unlock/ })).toBeVisible();
    // The note is fetched after the form appears; give it the time a demo would take, then check it never showed.
    await page.waitForTimeout(500);
    await expect(page.getByRole("note")).toHaveCount(0);
    expect(await page.locator("body").textContent(), path).not.toMatch(/PIN \d|demo/i);
  }
  await context.close();
});
