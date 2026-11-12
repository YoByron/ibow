/**
 * M6 demo mode as a stranger meets it: `npm run demo` prints the URLs and PINs, and with only those the owner sees a
 * week of numbers, the counter has open orders and the storefront takes an order.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { addSized } from "./helpers.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const phone = { isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

let child: ChildProcess | undefined;
// The demo deletes its own temporary data on Ctrl+C, but a killed process can't; the test owns this directory.
let dataDir: string | undefined;
test.afterEach(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child?.once("exit", resolve));
    // The demo runs the real server as its own child: kill the whole tree, or that grandchild keeps the SQLite file open.
    if (process.platform === "win32" && child.pid !== undefined) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    } else child.kill();
    await exited;
  }
  child = undefined;
  if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  dataDir = undefined;
});

test("npm run demo prints the URLs and PINs, and they open a seeded dashboard, counter and storefront", async ({
  browser,
}) => {
  test.setTimeout(240_000); // a cold start builds the client and seeds eight days
  const port = await freePort();
  dataDir = mkdtempSync(join(tmpdir(), "ibow-demo-e2e-"));
  const proc = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "scripts/demo.ts", "--port", String(port), "--data", dataDir],
    {
      cwd: root,
      env: { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "", IBOW_SKIP_BUILD: "1" },
    },
  );
  child = proc;
  let out = "";
  proc.stdout?.on("data", (d: Buffer) => {
    out += d.toString();
  });
  proc.stderr?.on("data", (d: Buffer) => {
    out += d.toString();
  });
  await expect.poll(() => out, { timeout: 120_000 }).toContain("Ctrl+C stops it");
  const owner = /Owner\s+(\S+)\s+PIN (\d{6})/.exec(out);
  const staff = /Staff\s+(\S+)\s+counter: ID counter, PIN (\d{4})/.exec(out);
  const store = /Storefront\s+(\S+)/.exec(out);
  expect(owner && staff && store, out).toBeTruthy();
  const [, ownerUrl, ownerPin] = owner as RegExpExecArray;
  const [, staffUrl, counterPin] = staff as RegExpExecArray;
  const [, storeUrl] = store as RegExpExecArray;
  expect(out).toContain("ibow-demo@example");

  const dash = await (await browser.newContext(phone)).newPage();
  await dash.goto(ownerUrl as string);
  await expect(dash.getByRole("note")).toContainText(ownerPin as string);
  await dash.getByLabel("Owner PIN").fill(ownerPin as string);
  await dash.getByRole("button", { name: "Unlock dashboard" }).click();
  // Today depends on the hour the test runs (none before opening); yesterday is always a whole day.
  await expect(dash.getByTestId("stat-ordered")).toContainText(/Yesterday, whole day: \d{3} orders/);
  await expect(dash.getByTestId("forecast")).toContainText("same weekday");

  const counter = await (await browser.newContext(phone)).newPage();
  await counter.goto(staffUrl as string);
  await counter.getByLabel("Staff ID").fill("counter");
  await counter.getByLabel("PIN").fill(counterPin as string);
  await counter.getByRole("button", { name: "Unlock", exact: true }).click();
  await counter.getByRole("link", { name: "Counter" }).click();
  await expect(counter.getByRole("button", { name: /^Pending \d+/ })).toBeVisible();

  const customer = await (await browser.newContext(phone)).newPage();
  await customer.goto(storeUrl as string);
  await addSized(customer, "House Special Chai", "M");
  await customer.getByTestId("cart-bar").click();
  await customer.getByRole("button", { name: "Place order" }).click();
  await expect(customer.getByTestId("token")).toHaveText(/^\d{2}-\d{3}$/);
});
