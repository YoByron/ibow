import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

/** An item with sizes: ADD opens the sheet, the size is chosen, then added. */
export async function addSized(page: Page, item: string, size: string): Promise<void> {
  await page.getByRole("button", { name: `Add ${item}` }).click();
  await page.getByRole("radio", { name: new RegExp(`^${size}`) }).click();
  await page.getByTestId("sheet-add").click();
}

/**
 * The sample with its opening hours taken out, so ordering works whatever the time is where the test runs (the sample
 * stops taking orders after its last-order time; that rule has its own unit tests).
 */
export function anyHourConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "ibow-e2e-cfg-"));
  cpSync(fileURLToPath(new URL("../samples/garden-cafe", import.meta.url)), dir, { recursive: true });
  const file = join(dir, "business.json");
  const business = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  delete business.hours;
  writeFileSync(file, JSON.stringify(business));
  return dir;
}
