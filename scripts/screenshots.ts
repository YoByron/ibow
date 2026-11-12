// Regenerates the README's screenshots from the demo: node scripts/screenshots.ts
// Starts the tea-house demo on a free port, drives it with Playwright's Chromium (the installed build; nothing is
// downloaded) on a phone-sized screen, and writes docs/media/*.png. With ffmpeg on the PATH it also records a rush on
// a station screen as docs/media/rush.gif; without it, the GIF is skipped.
// The browser uses en-US and the sample's own time zone, so text and times are the same on any machine. Time stands
// still at 6:30 PM on today's date in that zone, on the server (the demo's IBOW_DEMO_NOW, D-054: honoured by a demo
// database only) and in every page (Playwright's clock), so the shop is open, the seeded day runs up to 6:30 PM and the
// opening-hours line shows whenever this runs.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, chromium, type Page } from "@playwright/test";
import { instantOn } from "../src/demo/clock.ts";
import { startDemo } from "./demo.ts";

const media = fileURLToPath(new URL("../docs/media/", import.meta.url));
/** The tea-house sample's zone (samples/tea-house/business.json). */
const ZONE = "Asia/Kolkata";
const NOW = instantOn(ZONE, Date.now(), 18, 30);

/** A browser context whose clock reads 6:30 PM, like the server's, and then runs on. */
async function newContext(browser: Browser, options: Parameters<Browser["newContext"]>[0]): Promise<BrowserContext> {
  const ctx = await browser.newContext(options);
  await ctx.clock.install({ time: NOW });
  return ctx;
}

const phone = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  locale: "en-US",
  timezoneId: ZONE,
};

/** Speech and printing do nothing in a headless browser; stubbing them keeps the screens from waiting on either. */
function quietInit(): void {
  const synth = { speak: () => {}, cancel: () => {}, getVoices: () => [], speaking: false, pending: false };
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
  window.print = () => {};
}

async function staffPage(ctx: BrowserContext, base: string, user: string, pin: string, hash: string): Promise<Page> {
  await ctx.addInitScript(quietInit);
  const login = await ctx.request.post(`${base}/api/login`, { data: { user, pin } });
  if (login.status() !== 200) throw new Error(`screenshots: expected ${user} to sign in, found ${login.status()}`);
  const page = await ctx.newPage();
  await page.goto(`${base}/staff${hash}`);
  await page.getByRole("button", { name: "Tap to start (turns sound on)" }).click();
  return page;
}

async function shot(page: Page, name: string, fullPage = false): Promise<void> {
  const path = join(media, `${name}.png`);
  await page.screenshot({ path, fullPage });
  console.log(`${`docs/media/${name}.png`.padEnd(28)}${(statSync(path).size / 1024).toFixed(0).padStart(5)} KB`);
}

async function order(base: string, lines: unknown[]): Promise<void> {
  const res = await fetch(`${base}/api/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientKey: randomBytes(16).toString("base64url"), lines }),
  });
  if (res.status !== 201) throw new Error(`screenshots: expected an order to be created, found ${res.status}`);
}

async function rushGif(browser: Browser, base: string, pin: string): Promise<void> {
  const ffmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  if (ffmpeg.status !== 0) {
    console.log("docs/media/rush.gif           skipped: ffmpeg is not on the PATH");
    return;
  }
  const videoDir = mkdtempSync(join(tmpdir(), "ibow-rush-"));
  try {
    const ctx = await newContext(browser, { ...phone, recordVideo: { dir: videoDir, size: phone.viewport } });
    const page = await staffPage(ctx, base, "station", pin, "#/station/tea");
    await page.getByTestId("batch-text").waitFor();
    const chai = (size: string, qty: number) => ({ itemId: "house-special-chai", size, qty });
    const rush: unknown[][] = [
      [chai("M", 2)],
      [chai("S", 1), { itemId: "hot-coffee", size: "M", qty: 1 }],
      [chai("M", 3)],
      [{ itemId: "cold-coffee", qty: 2 }],
      [chai("L", 1), chai("M", 1)],
      [{ itemId: "hot-coffee", size: "S", qty: 2 }],
      [chai("M", 2)],
      [chai("S", 2)],
    ];
    await page.waitForTimeout(1200);
    for (const lines of rush) {
      await order(base, lines);
      await page.waitForTimeout(900);
    }
    await page.waitForTimeout(1500);
    const video = page.video();
    await ctx.close();
    const webm = await video?.path();
    if (webm === undefined) throw new Error("screenshots: expected a recorded video, found none");
    const out = join(media, "rush.gif");
    const palette =
      "fps=4,scale=270:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=24:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle";
    const run = spawnSync(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-ss", "1", "-i", webm, "-vf", palette, "-loop", "0", out],
      {
        encoding: "utf8",
      },
    );
    if (run.status !== 0) throw new Error(`screenshots: expected ffmpeg to make the GIF, found:\n${run.stderr}`);
    console.log(`${"docs/media/rush.gif".padEnd(28)}${(statSync(out).size / 1024).toFixed(0).padStart(5)} KB`);
  } finally {
    try {
      rmSync(videoDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch {
      // Best effort: after a failure the browser may still hold the video; the OS cleans its temp folder.
    }
  }
}

const demo = await startDemo({ sample: "tea-house", port: 0, quiet: true, now: NOW });
const browser = await chromium.launch();
try {
  mkdirSync(media, { recursive: true });
  const base = demo.base;

  // The customer: the menu, the size sheet, then an order and its live token page with the UPI QR.
  const customer = await (await newContext(browser, phone)).newPage();
  await customer.goto(`${base}/`);
  await customer.locator(".item").first().waitFor();
  // The opening-hours line is part of the picture: fail loudly if the shop reads as closed.
  await customer.getByText("Open now").first().waitFor();
  await customer.waitForTimeout(500);
  await shot(customer, "storefront");
  await customer.getByRole("button", { name: "Add House Special Chai" }).click();
  await customer.getByRole("radio", { name: /^M/ }).click();
  await customer.waitForTimeout(600);
  await shot(customer, "size-sheet");
  await customer.getByTestId("sheet-add").click();
  await customer.getByRole("searchbox").fill("momos");
  await customer.getByRole("button", { name: "Add Veg Momos S/F" }).click();
  await customer.getByTestId("cart-bar").click();
  await customer.getByLabel("Your name (optional)").fill("Asha");
  await shot(customer, "cart");
  await customer.getByRole("button", { name: "Place order" }).click();
  await customer.getByTestId("token").waitFor();
  await customer.getByRole("img", { name: /^UPI QR code/ }).waitFor();
  await shot(customer, "token");

  // Staff: the counter's pending orders and its cash sheet, and the tea station's spoken batch.
  const counter = await staffPage(await newContext(browser, phone), base, "counter", demo.pins.counter, "#/counter");
  await counter.getByRole("button", { name: /^Pending [1-9]/ }).waitFor();
  await shot(counter, "counter");
  await counter.getByRole("button", { name: /^Cash/ }).first().click();
  await counter.getByRole("button", { name: /^₹/ }).first().click();
  await counter.waitForTimeout(500);
  await shot(counter, "counter-cash");
  const station = await staffPage(
    await newContext(browser, phone),
    base,
    "station",
    demo.pins.station,
    "#/station/tea",
  );
  await station.getByTestId("batch-text").waitFor();
  await shot(station, "station");

  // The owner: the PIN screen, today's numbers on a desktop, and the Appearance screen with its preview.
  const ownerPin = await (await newContext(browser, phone)).newPage();
  await ownerPin.goto(`${base}/owner`);
  await ownerPin.getByLabel("Owner PIN").waitFor();
  await ownerPin.getByRole("button", { name: "1", exact: true }).click();
  await ownerPin.getByRole("button", { name: "2", exact: true }).click();
  await ownerPin.getByRole("button", { name: "3", exact: true }).click();
  await shot(ownerPin, "pin");
  const owner = await (
    await newContext(browser, {
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
      locale: "en-US",
      timezoneId: ZONE,
    })
  ).newPage();
  await owner.goto(`${base}/owner`);
  await owner.getByLabel("Owner PIN").fill(demo.pins.owner);
  await owner.getByRole("button", { name: "Unlock dashboard" }).click();
  await owner.locator("svg.chart rect.bar.peak").waitFor();
  await shot(owner, "owner");
  await owner.getByRole("link", { name: "Appearance" }).click();
  await owner.locator(".preview .item").first().waitFor();
  await owner.setViewportSize({ width: 1280, height: 1000 });
  await owner.waitForTimeout(500);
  await shot(owner, "appearance");

  // The dashboard at phone width: the same page, stacked.
  const ownerPhone = await (await newContext(browser, phone)).newPage();
  await ownerPhone.goto(`${base}/owner`);
  await ownerPhone.getByLabel("Owner PIN").fill(demo.pins.owner);
  await ownerPhone.getByRole("button", { name: "Unlock dashboard" }).click();
  await ownerPhone.locator("svg.chart rect.bar.peak").waitFor();
  await ownerPhone.waitForTimeout(500);
  await shot(ownerPhone, "owner-phone", true);

  await rushGif(browser, base, demo.pins.station);
} finally {
  await demo.stop();
}

// The same bundles under two other themes from their configs (no code differs): an espresso serif look in dark mode
// and a compact square blue one with its own words and a logo image.
for (const [sample, name, dark] of [
  ["coffee-cart", "themed-coffee-cart", true],
  ["service-desk", "themed-service-desk", false],
] as const) {
  const other = await startDemo({ sample, port: 0, quiet: true, now: NOW });
  try {
    const page = await (await newContext(browser, phone)).newPage();
    await page.goto(`${other.base}/`);
    await page.locator(".item").first().waitFor();
    if (dark) await page.getByRole("button", { name: "Dark mode" }).click();
    await page.waitForTimeout(500);
    await shot(page, name);
  } finally {
    await other.stop();
  }
}
await browser.close();
