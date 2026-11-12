import type { Page } from "@playwright/test";

/** An item with sizes: ADD opens the sheet, the size is chosen, then added. */
export async function addSized(page: Page, item: string, size: string): Promise<void> {
  await page.getByRole("button", { name: `Add ${item}` }).click();
  await page.getByRole("radio", { name: new RegExp(`^${size}`) }).click();
  await page.getByTestId("sheet-add").click();
}
