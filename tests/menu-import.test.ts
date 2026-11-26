/**
 * M15: menu import. The model reads a menu (a photo or text) and answers JSON; code checks it, makes ids, converts
 * prices to minor units, merges pages, maps add-ons to the extras library and proves the result loads. Every model
 * here is the fake Chat Completions server: no network, no key.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { importMenuCli } from "../scripts/import-menu.ts";
import { readMenuPiece } from "../src/ai/menu-reader.ts";
import { AiError } from "../src/ai/model.ts";
import { parseCatalog } from "../src/core/config.ts";
import { buildCatalog, parseReply, priceOf, tidyName, tidySection } from "../src/import/catalog.ts";
import { htmlToText, splitText } from "../src/import/inputs.ts";
import { chat, type FakeModel, type SeenRequest, startFakeModel } from "./support/fake-model.ts";

/** A real 1x1 PNG: the fake model never looks at the pixels, but the importer checks the bytes are a PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

let fake: FakeModel;
let dir: string;
beforeAll(async () => {
  fake = await startFakeModel();
});
afterAll(() => fake.close());
beforeEach(() => {
  fake.seen.length = 0;
  dir = mkdtempSync(join(tmpdir(), "ibow-menu-"));
  return () => rmSync(dir, { recursive: true, force: true });
});

function file(name: string, content: string | Buffer): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

function userText(req: SeenRequest): string {
  const content = (req.body.messages as { role: string; content: unknown }[]).find((m) => m.role === "user")?.content;
  if (typeof content === "string") return content;
  return (content as { type: string; text?: string }[]).map((p) => p.text ?? "").join("\n");
}

function hasImage(req: SeenRequest): boolean {
  const content = (req.body.messages as { role: string; content: unknown }[]).find((m) => m.role === "user")?.content;
  return Array.isArray(content) && content.some((p: { type: string }) => p.type === "image_url");
}

async function run(
  args: string[],
  env: Record<string, string> = { AI_BASE_URL: fake.baseUrl, AI_MODEL: "fake-vision" },
) {
  let stdout = "";
  let stderr = "";
  const code = await importMenuCli(args, env, {
    out: (s) => {
      stdout += s;
    },
    err: (s) => {
      stderr += s;
    },
  });
  return { code, stdout, stderr };
}

const ESPRESSO_PAGE = {
  sections: [
    {
      name: "Coffee",
      items: [
        { name: "Espresso", price: 2.5, tags: ["vegan"], diet: "veg" },
        {
          name: "Flat White",
          sizes: [
            { size: "Regular", price: 3.5 },
            { size: "Large", price: 4.25 },
          ],
          addons: ["Syrups"],
        },
      ],
    },
  ],
  addons: [
    {
      name: "Milk",
      min: 0,
      max: 1,
      sections: ["Coffee"],
      options: [
        { name: "Oat milk", price: 0.5 },
        { name: "Whole milk", price: 0 },
      ],
    },
    { name: "Syrups", options: [{ name: "Vanilla", price: 0.4 }] },
  ],
};

const CAKE_PAGE = {
  sections: [
    { name: "Cakes", items: [{ name: "Carrot cake", price: 4, description: "With walnuts and cream cheese." }] },
  ],
};

describe("an image and a text input make a catalog that loads", () => {
  test("the image goes to the model as a data URL, the text as text, and the catalog parses", async () => {
    fake.reply = (req) => chat(JSON.stringify(hasImage(req) ? ESPRESSO_PAGE : CAKE_PAGE));
    const out = join(dir, "config", "catalog.json");
    const r = await run([
      file("page-1.png", PNG),
      file("cakes.txt", "CAKES\nCarrot cake 4.00\n"),
      "--out",
      out,
      "--currency",
      "USD",
    ]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(fake.seen).toHaveLength(2);
    const imageReq = fake.seen[0]?.body.messages[1].content;
    expect(imageReq[1].image_url.url).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);
    expect(userText(fake.seen[1] as SeenRequest)).toContain("Carrot cake 4.00");
    const catalog = parseCatalog(JSON.parse(readFileSync(out, "utf8")));
    expect(catalog.categories.map((c) => c.id)).toEqual(["coffee", "cakes"]);
    const [espresso, flatWhite] = catalog.categories[0]?.items ?? [];
    expect(espresso).toEqual({ id: "espresso", name: "Espresso", price: 250, tags: ["vegan"], diet: "veg" });
    expect(flatWhite?.variants).toEqual([
      { size: "Regular", price: 350 },
      { size: "Large", price: 425 },
    ]);
    expect(catalog.categories[1]?.items[0]?.description).toBe("With walnuts and cream cheese.");
    expect(r.stdout).toMatch(/2 model calls/);
  });

  test("the model's name comes from AI_MODEL; nothing else in the request names a model or a vendor", async () => {
    fake.reply = () => chat(JSON.stringify(CAKE_PAGE));
    await run([file("m.md", "# Cakes\n- Carrot cake 4"), "--out", join(dir, "catalog.json"), "--currency", "USD"], {
      AI_BASE_URL: fake.baseUrl,
      AI_MODEL: "any-model-name",
    });
    expect(fake.seen[0]?.body.model).toBe("any-model-name");
  });
});

describe("prices in minor units of the currency", () => {
  const menu = {
    sections: [
      {
        name: "Tea",
        items: [
          { name: "Masala chai", price: 20 },
          { name: "Samosa", price: "₹ 1,250.50" },
        ],
      },
    ],
  };

  test("INR: whole rupees and a printed price with a symbol and thousands are paise", () => {
    const { catalog } = buildCatalog([{ file: "menu.txt", reply: menu }], "INR");
    expect(catalog.categories[0]?.items.map((i) => i.price)).toEqual([2000, 125050]);
  });

  test("a 3-decimal currency (KWD) has 1000 fils to the dinar", () => {
    const kwd = {
      sections: [
        {
          name: "Tea",
          items: [
            { name: "Karak", price: 0.25 },
            { name: "Saffron tea", price: 1.125 },
          ],
        },
      ],
    };
    const { catalog, review } = buildCatalog([{ file: "menu.txt", reply: kwd }], "KWD");
    expect(catalog.categories[0]?.items.map((i) => i.price)).toEqual([250, 1125]);
    expect(review).toEqual([]);
  });

  test("a range, a deal or a minus sign is never one merged number: the item is left out and flagged odd", () => {
    for (const printed of ["10-12", "2 for 5", "-5", "1.2.3"]) {
      expect(priceOf(printed, "USD")).toEqual({ odd: `${JSON.stringify(printed)} is not one price` });
    }
    const menu = {
      sections: [
        {
          name: "Deals",
          items: [
            { name: "Cookies", price: "2 for 5" },
            { name: "Tea", price: 2 },
          ],
        },
      ],
    };
    const { catalog, review } = buildCatalog([{ file: "m.txt", reply: menu }], "USD");
    expect(catalog.categories[0]?.items.map((i) => i.name)).toEqual(["Tea"]);
    expect(review).toEqual([expect.objectContaining({ kind: "odd price", item: "Cookies" })]);
  });

  test("a currency word or symbol before the number, with its dot, is dropped", () => {
    for (const printed of ["Rs. 120", "Rs 120", "INR 120", "₹120", "₹ 120", "120 ₹", "120/-"]) {
      expect(priceOf(printed, "INR")).toEqual({ minor: 12000 });
    }
    expect(priceOf("$3.50", "USD")).toEqual({ minor: 350 });
    expect(priceOf("3,50 €", "EUR")).toEqual({ minor: 350 });
  });

  test("more decimals than the currency has is rounded and flagged as odd", () => {
    const odd = { sections: [{ name: "Tea", items: [{ name: "Chai", price: 20.555 }] }] };
    const { catalog, review } = buildCatalog([{ file: "menu.txt", reply: odd }], "INR");
    expect(catalog.categories[0]?.items[0]?.price).toBe(2056);
    expect(review).toEqual([expect.objectContaining({ file: "menu.txt", kind: "odd price" })]);
  });
});

describe("pages merged in order", () => {
  test("a section continued on the next page is one category; the same item twice is one item, flagged", () => {
    const p1 = {
      sections: [
        {
          name: "Coffee",
          items: [
            { name: "Espresso", price: 2.5 },
            { name: "Latte", price: 3.5 },
          ],
        },
      ],
    };
    const p2 = {
      sections: [
        {
          name: "COFFEE",
          items: [
            { name: "Latte", price: 3.5 },
            { name: "Mocha", price: 4 },
          ],
        },
        { name: "Cakes", items: [{ name: "Brownie", price: 3 }] },
      ],
    };
    const { catalog, review } = buildCatalog(
      [
        { file: "p1.png", reply: p1 },
        { file: "p2.png", reply: p2 },
      ],
      "USD",
    );
    expect(catalog.categories.map((c) => [c.id, c.items.map((i) => i.id)])).toEqual([
      ["coffee", ["espresso", "latte", "mocha"]],
      ["cakes", ["brownie"]],
    ]);
    expect(review).toEqual([expect.objectContaining({ file: "p2.png", kind: "duplicate", item: "Latte" })]);
  });

  test("a duplicate with another price keeps the first and says both", () => {
    const p1 = { sections: [{ name: "Coffee", items: [{ name: "Latte", price: 3.5 }] }] };
    const p2 = { sections: [{ name: "Coffee", items: [{ name: "Latte", price: 3.8 }] }] };
    const { catalog, review } = buildCatalog(
      [
        { file: "p1.png", reply: p1 },
        { file: "p2.png", reply: p2 },
      ],
      "USD",
    );
    expect(catalog.categories[0]?.items[0]?.price).toBe(350);
    expect(review[0]?.detail).toMatch(/3\.5.*3\.8|3\.80/);
  });

  test("the same name in two sections gets two stable ids", () => {
    const menu = {
      sections: [
        { name: "Drinks", items: [{ name: "Lemonade", price: 3 }] },
        { name: "Kids", items: [{ name: "Lemonade", price: 2 }] },
      ],
    };
    const a = buildCatalog([{ file: "m.txt", reply: menu }], "USD");
    const b = buildCatalog([{ file: "m.txt", reply: menu }], "USD");
    expect(a.catalog.categories.map((c) => c.items[0]?.id)).toEqual(["lemonade", "kids-lemonade"]);
    expect(b.catalog).toEqual(a.catalog);
  });

  test("names in other scripts still get ids", () => {
    const menu = {
      sections: [
        {
          name: "चाय",
          items: [
            { name: "मसाला चाय", price: 20 },
            { name: "Café crème", price: 30 },
          ],
        },
      ],
    };
    const { catalog } = buildCatalog([{ file: "m.txt", reply: menu }], "INR");
    expect(() => parseCatalog(catalog)).not.toThrow();
    expect(catalog.categories[0]?.items[1]?.id).toBe("cafe-creme");
  });
});

describe("add-ons become the extras library", () => {
  test("groups get ids, options get ids unique across the library and prices in minor units", () => {
    const { catalog } = buildCatalog([{ file: "p1.png", reply: ESPRESSO_PAGE }], "USD");
    expect(catalog.extras).toEqual([
      {
        id: "milk",
        name: "Milk",
        min: 0,
        max: 1,
        options: [
          { id: "oat-milk", name: "Oat milk", price: 50 },
          { id: "whole-milk", name: "Whole milk", price: 0 },
        ],
      },
      { id: "syrups", name: "Syrups", min: 0, max: 1, options: [{ id: "vanilla", name: "Vanilla", price: 40 }] },
    ]);
    expect(catalog.categories[0]?.extras).toEqual(["milk"]);
    expect(catalog.categories[0]?.items[1]?.extras).toEqual(["syrups"]);
    expect(() => parseCatalog(catalog)).not.toThrow();
  });

  test("an option name in two groups gets a distinct id; a group on no item and an unknown group are flagged", () => {
    const menu = {
      sections: [{ name: "Bowls", items: [{ name: "Poke", price: 12, addons: ["Toppings", "Sauces"] }] }],
      addons: [
        { name: "Toppings", options: [{ name: "Extra", price: 1 }] },
        { name: "Sides", options: [{ name: "Extra", price: 2 }] },
      ],
    };
    const { catalog, review } = buildCatalog([{ file: "m.txt", reply: menu }], "USD");
    expect(catalog.extras?.map((g) => g.options.map((o) => o.id))).toEqual([["extra"], ["sides-extra"]]);
    expect(review.map((r) => r.kind).sort()).toEqual(["unknown add-on", "unused add-on"]);
    expect(() => parseCatalog(catalog)).not.toThrow();
  });
});

describe("the review report", () => {
  test("an item without a price is left out of the catalog and listed with its file", async () => {
    fake.reply = () =>
      chat(
        JSON.stringify({
          sections: [
            {
              name: "Tea",
              items: [
                { name: "Chai", price: 20 },
                { name: "Seasonal special", price: null },
              ],
            },
          ],
        }),
      );
    const out = join(dir, "catalog.json");
    const report = join(dir, "review.md");
    const r = await run([
      file("tea.txt", "Chai 20\nSeasonal special - ask us"),
      "--out",
      out,
      "--currency",
      "INR",
      "--report",
      report,
    ]);
    expect(r.code).toBe(0);
    const catalog = parseCatalog(JSON.parse(readFileSync(out, "utf8")));
    expect(catalog.categories[0]?.items.map((i) => i.name)).toEqual(["Chai"]);
    const text = readFileSync(report, "utf8");
    expect(text).toContain("tea.txt");
    expect(text).toMatch(/no price.*Seasonal special/);
    expect(r.stdout).toMatch(/1 to check/);
  });

  test("an unreadable name, an unsure reading, an unknown tag and an unknown diet are flagged", () => {
    const menu = {
      sections: [
        {
          name: "Food",
          items: [
            { name: "", price: 5 },
            { name: "Pa?er", price: 6, unsure: true },
            { name: "Salad", price: 7, tags: ["vegan", "chef-favourite"], diet: "pescatarian" },
          ],
        },
      ],
    };
    const { catalog, review } = buildCatalog([{ file: "m.png", reply: menu }], "USD");
    expect(catalog.categories[0]?.items.map((i) => i.name)).toEqual(["Pa?er", "Salad"]);
    expect(catalog.categories[0]?.items.map((i) => i.available)).toEqual([false, undefined]);
    expect(review[1]?.detail).toMatch(/switched off/);
    expect(catalog.categories[0]?.items[1]?.tags).toEqual(["vegan", "chef-favourite"]);
    expect(catalog.categories[0]?.items[1]?.diet).toBeUndefined();
    expect(review.map((r) => r.kind)).toEqual(["unreadable name", "unsure", "unknown tag", "unknown diet"]);
  });

  test("categories without a station in the folder's stations.json are listed", async () => {
    fake.reply = () => chat(JSON.stringify(CAKE_PAGE));
    mkdirSync(join(dir, "cfg"));
    writeFileSync(
      join(dir, "cfg", "stations.json"),
      JSON.stringify([{ id: "bar", name: "Bar", categories: ["coffee"] }]),
    );
    writeFileSync(join(dir, "cfg", "business.json"), JSON.stringify({ currency: "EUR" }));
    const r = await run([file("m.txt", "Carrot cake 4"), "--out", join(dir, "cfg", "catalog.json")]);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/no station.*cakes/);
    expect(JSON.parse(readFileSync(join(dir, "cfg", "catalog.json"), "utf8")).categories[0].items[0].price).toBe(400);
  });
});

describe("text extracted in code", () => {
  test("HTML loses its tags, scripts, styles and comments, keeps lines and decodes entities", () => {
    const html = `<!doctype html><html><head><title>x</title><style>.p{color:red}</style>
      <script>var price = "999";</script></head><body><!-- hidden 777 -->
      <h2>Coffee &amp; Tea</h2><ul><li>Latte <span class="p">&pound;3.50</span></li><li>Chai&nbsp;&#8377;20</li></ul>
      <table><tr><td>Mocha</td><td>4.00</td></tr></table></body></html>`;
    const text = htmlToText(html);
    expect(text).toBe("Coffee & Tea\nLatte £3.50\nChai ₹20\nMocha 4.00");
  });

  test("an HTML input reaches the model as plain text", async () => {
    fake.reply = () => chat(JSON.stringify(CAKE_PAGE));
    await run([
      file("menu.html", "<p>Carrot <b>cake</b> 4</p><script>steal()</script>"),
      "--out",
      join(dir, "c.json"),
      "--currency",
      "USD",
    ]);
    const sent = userText(fake.seen[0] as SeenRequest);
    expect(sent).toContain("Carrot cake 4");
    expect(sent).not.toMatch(/<|steal/);
  });

  test("a big menu is split at blank lines into parts under the budget, in order", () => {
    const sections = Array.from({ length: 30 }, (_, i) => `Section ${i}\n${"Item 1.00\n".repeat(20)}`).join("\n");
    const parts = splitText(sections, 1000);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 1000)).toBe(true);
    expect(parts.join("\n\n").replace(/\n+/g, "\n")).toBe(sections.replace(/\n+/g, "\n").trim());
    expect(parts[1]?.startsWith("Section")).toBe(true);
  });

  test("each part of a big text file is one model call, and the parts' results merge", async () => {
    fake.reply = (req) => {
      const n = /Section (\d+)/.exec(userText(req))?.[1];
      return chat(JSON.stringify({ sections: [{ name: `Section ${n}`, items: [{ name: `Dish ${n}`, price: 1 }] }] }));
    };
    const big = Array.from(
      { length: 40 },
      (_, i) => `Section ${i}\n${"A dish with a long name 1.00\n".repeat(30)}`,
    ).join("\n");
    const r = await run([file("big.txt", big), "--out", join(dir, "c.json"), "--currency", "USD"]);
    expect(r.code).toBe(0);
    expect(fake.seen.length).toBeGreaterThan(1);
    expect(r.stdout).toContain(`${fake.seen.length} model calls`);
  });
});

describe("the model's reply", () => {
  test("JSON in a code fence or after a sentence is read; anything else is a reason, not a crash", () => {
    expect(parseReply('```json\n{"sections": []}\n```')).toEqual({ ok: true, menu: { sections: [] } });
    expect(parseReply('Here it is: {"sections": []}')).toEqual({ ok: true, menu: { sections: [] } });
    expect(parseReply("I can't read this image.")).toMatchObject({ ok: false });
    expect(parseReply('{"sections": "none"}')).toMatchObject({ ok: false });
  });

  test("one unreadable part is reported and skipped; the rest is imported", async () => {
    fake.reply = (req) => (hasImage(req) ? chat("Sorry, too blurry.") : chat(JSON.stringify(CAKE_PAGE)));
    const out = join(dir, "c.json");
    const r = await run([
      file("blurry.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])),
      file("m.txt", "Carrot cake 4"),
      "--out",
      out,
      "--currency",
      "USD",
    ]);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/blurry\.jpg.*not menu JSON/);
    expect(existsSync(out)).toBe(true);
  });
});

describe("failures say what was expected, what was found and where", () => {
  const out = () => join(dir, "catalog.json");

  test("no model configured", async () => {
    const r = await run([file("m.txt", "Tea 1"), "--out", out(), "--currency", "USD"], {});
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/expected AI_BASE_URL and AI_MODEL.*found neither/);
    expect(fake.seen).toHaveLength(0);
  });

  test("a half-set configuration says what is missing", async () => {
    const r = await run([file("m.txt", "Tea 1"), "--out", out(), "--currency", "USD"], { AI_BASE_URL: fake.baseUrl });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/AI_MODEL/);
  });

  test("a model error stops the import, names the input and the provider's answer, and writes nothing", async () => {
    fake.reply = () => ({ status: 400, json: { error: { message: "this model does not accept images" } } });
    const r = await run([file("p1.webp", Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "--out", out(), "--currency", "USD"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/p1\.webp.*ai_refused.*400.*does not accept images/);
    expect(existsSync(out())).toBe(false);
  });

  test("nothing parseable: every reply unreadable", async () => {
    fake.reply = () => chat("no menu here");
    const r = await run([file("m.txt", "Tea 1"), "--out", out(), "--currency", "USD"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/expected at least one item with a price.*found none/);
    expect(existsSync(out())).toBe(false);
  });

  test("a PDF is refused before any call, with what to do instead", async () => {
    const r = await run([file("menu.pdf", "%PDF-1.7"), "--out", out(), "--currency", "USD"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/menu\.pdf.*export.*images/i);
    expect(fake.seen).toHaveLength(0);
  });

  test("unknown types, missing files, images that aren't, and empty text are refused before any call", async () => {
    for (const [args, message] of [
      [[file("menu.docx", "x")], /menu\.docx.*expected .*png.*found \.docx/],
      [[join(dir, "missing.txt")], /missing\.txt.*no such file/],
      [[file("fake.png", "not a png")], /fake\.png.*expected a PNG image/],
      [[file("blank.html", "<script>x()</script>")], /blank\.html.*expected menu text.*found none/],
    ] as const) {
      const r = await run([...args, "--out", out(), "--currency", "USD"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(message);
    }
    expect(fake.seen).toHaveLength(0);
  });

  test("usage: no input, no --out, a bad currency, no currency, an unknown flag, an existing catalog", async () => {
    const txt = file("m.txt", "Tea 1");
    writeFileSync(out(), "{}");
    for (const [args, message] of [
      [["--out", out()], /expected at least one menu file/],
      [[txt, "--currency", "USD"], /expected --out/],
      [
        [txt, "--out", join(dir, "x.json"), "--currency", "RUPEES"],
        /expected --currency to be an ISO 4217 code.*RUPEES/,
      ],
      [[txt, "--out", join(dir, "x.json")], /expected --currency.*business\.json/],
      [[txt, "--out", join(dir, "x.json"), "--currency", "USD", "--colour"], /unknown option --colour/],
      [[txt, "--out", out(), "--currency", "USD"], /already exists.*--force/],
    ] as const) {
      const r = await run([...args]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(message);
    }
    expect(fake.seen).toHaveLength(0);
    expect(readFileSync(out(), "utf8")).toBe("{}");
  });
});

describe("a busy model (D-095)", () => {
  const piece = { label: "one page", text: "Tea 20" };
  const busy = new AiError("ai_refused", "the AI model at http://x answered 503: no capacity");
  test("a busy answer is asked again after each wait, and the reply after it is used", async () => {
    const waited: number[] = [];
    let calls = 0;
    const model = { complete: async () => (++calls < 3 ? Promise.reject(busy) : "{}") };
    const reply = await readMenuPiece(model, piece, undefined, [1, 2, 3], async (ms) => void waited.push(ms));
    expect([reply, calls, waited]).toEqual(["{}", 3, [1, 2]]);
  });
  test("after the last wait, or for a refusal that isn't busy, the error is thrown at once", async () => {
    const always = { complete: async () => Promise.reject(busy) };
    await expect(readMenuPiece(always, piece, undefined, [1], async () => {})).rejects.toThrow("answered 503");
    let calls = 0;
    const badKey = {
      complete: async () => (
        calls++, Promise.reject(new AiError("ai_refused", "the AI model at http://x answered 401: bad key"))
      ),
    };
    await expect(readMenuPiece(badKey, piece, undefined, [1, 2], async () => {})).rejects.toThrow("401");
    expect(calls).toBe(1);
  });
});

describe("names as a guest reads them (D-094)", () => {
  test("an all-capitals name is title-cased, keeping acronyms and small words; the café's own casing stays", () => {
    expect(tidyName("SHALLOW FRIED IDLY")).toBe("Shallow Fried Idly");
    expect(tidyName("BBQ CARAMELIZED ONION")).toBe("BBQ Caramelized Onion");
    expect(tidyName("CREAM OF BROCCOLI & SPINACH")).toBe("Cream of Broccoli & Spinach");
    expect(tidyName("PB&J TOAST")).toBe("PB&J Toast");
    expect(tidyName("Caffè Latte")).toBe("Caffè Latte");
    expect(tidySection("all day breakfast")).toBe("All day breakfast");
    expect(tidySection("BURGERS, WRAPS & SANDWICHES")).toBe("Burgers, Wraps & Sandwiches");
  });
});
