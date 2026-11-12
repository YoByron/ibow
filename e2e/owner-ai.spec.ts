/**
 * M7: the AI analyst on the owner's dashboard against the real server, with a fake Chat Completions server standing in
 * for the model (no network, no real key). With AI off the page has no analyst at all. With it on, the owner asks on
 * the Today page, the answer shows as text with the figure it cited, and the browser never talks to the model.
 */

import { expect, test } from "@playwright/test";
import { analystRequest, chat, type FakeModel, startFakeModel } from "../tests/support/fake-model.ts";
import { OWNER_PIN, type RunningServer, startServer } from "./server.ts";

let server: RunningServer | undefined;
let fake: FakeModel | undefined;
test.afterEach(async () => {
  await server?.stop();
  await fake?.close();
  server = undefined;
  fake = undefined;
});

const phone = { isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } };
const KEY = "e2e-key-not-real-0123456789";

async function placeOrder(base: string, n: number): Promise<void> {
  const res = await fetch(`${base}/api/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientKey: `owner-ai-e2e-key-${n}-abcdef`,
      lines: [{ itemId: "masala-soda", qty: 1 }],
      customerName: "Ottoline",
    }),
  });
  expect(res.status).toBe(201);
}

test("with AI off the owner's page has no analyst, and its script isn't served", async ({ browser }) => {
  server = await startServer("tea-house");
  const page = await (await browser.newContext(phone)).newPage();
  await page.goto(`${server.base}/owner`);
  await page.getByLabel("Owner PIN").fill(OWNER_PIN);
  await page.getByRole("button", { name: "Unlock dashboard" }).click();
  await expect(page.getByTestId("summary")).toBeVisible();
  await expect(page.getByText("Ask the analyst")).toHaveCount(0);
  expect((await fetch(`${server.base}/owner-ai.js`)).status).toBe(404);
  // With AI on this is 401 without a session; off, the route doesn't exist.
  const ask = await fetch(`${server.base}/api/owner/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "How many orders?" }),
  });
  expect(ask.status).toBe(404);
});

test("with AI on the owner asks on the Today page and reads a cited answer; only the server calls the model", async ({
  browser,
}) => {
  fake = await startFakeModel((req) => {
    const { question, figures } = analystRequest(req);
    // A model that makes a number up, for the warning.
    if (question.includes("guess")) return chat("You have 99 orders so far today [today.orders].");
    const f = figures.find((x) => x.key === "today.orders");
    return chat(`You have ${f?.value} orders so far today [today.orders].`);
  });
  const model = new URL(fake.baseUrl);
  server = await startServer("tea-house", { AI_BASE_URL: fake.baseUrl, AI_MODEL: "fake", AI_API_KEY: KEY });
  await placeOrder(server.base, 1);
  await placeOrder(server.base, 2);

  const page = await (await browser.newContext(phone)).newPage();
  const requested: string[] = [];
  page.on("request", (r) => requested.push(r.url()));
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("status of 401")) errors.push(m.text());
  });
  await page.goto(`${server.base}/owner`);
  // Not on the sign-in screen.
  await expect(page.getByLabel("Owner PIN")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ask the analyst" })).toBeHidden();
  await page.getByLabel("Owner PIN").fill(OWNER_PIN);
  await page.getByRole("button", { name: "Unlock dashboard" }).click();

  const panel = page.getByRole("region", { name: "Ask the analyst" });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("no customer names, no reviews");
  await panel.getByLabel("Your question").fill("How many orders today?");
  await panel.getByRole("button", { name: "Ask" }).click();
  const answer = page.getByTestId("analyst-answer");
  await expect(answer).toContainText("You have 2 orders so far today [today.orders].");
  await expect(answer).toContainText("Orders placed today: 2");
  await expect(answer.getByRole("alert")).toHaveCount(0);
  await expect(answer.locator("mark")).toHaveCount(0);

  // An unbacked number: the warning comes first and the number itself is marked.
  await panel.getByLabel("Your question").fill("Take a guess at today's orders");
  await panel.getByRole("button", { name: "Ask" }).click();
  await expect(answer.getByRole("alert")).toContainText("(99)");
  await expect(answer.locator("mark.unbacked")).toHaveText("99");
  const order = await answer.evaluate((el) => [...el.children].map((c) => c.tagName));
  expect(order.slice(0, 2)).toEqual(["P", "P"]);
  expect(await answer.locator(":scope > *").first().getAttribute("role")).toBe("alert");

  // Only the Today page shows it.
  await page.getByRole("link", { name: "Orders" }).click();
  await expect(panel).toBeHidden();
  await page.getByRole("link", { name: "Today" }).click();
  await expect(panel).toBeVisible();

  expect(fake.seen).toHaveLength(2);
  expect(fake.seen[0]?.raw).not.toContain("Ottoline");
  expect(requested.some((u) => new URL(u).port === model.port)).toBe(false);
  expect(requested.filter((u) => u.endsWith("/api/owner/ask"))).toHaveLength(2);
  const html = await (await fetch(`${server.base}/owner`)).text();
  expect(html).not.toContain(KEY);
  expect(errors).toEqual([]);
});
