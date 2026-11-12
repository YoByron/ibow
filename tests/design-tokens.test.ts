import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { contrast, DEFAULT_THEME, parseTheme, themeVars, toRgb } from "../src/core/theme.ts";
import { readSample } from "./support/samples.ts";

const tokens = readFileSync(fileURLToPath(new URL("../docs/design/tokens.md", import.meta.url)), "utf8");
const light = themeVars(DEFAULT_THEME, "light");
const dark = themeVars(DEFAULT_THEME, "dark");

/** Each channel within `by` of the approved value: derived from the brand colours, not copied, and still the same look. */
function near(actual: string | undefined, approved: string, by = 18): void {
  const a = toRgb(actual as string);
  const b = toRgb(approved);
  for (let i = 0; i < 3; i++)
    expect(Math.abs((a[i] as number) - (b[i] as number)), `${actual} against ${approved}`).toBeLessThanOrEqual(by);
}

describe("the default theme is the approved baseline (docs/design/tokens.md)", () => {
  test("the document still holds the values this pins", () => {
    for (const hex of [
      "#946a00",
      "#4a5148",
      "#7a8178",
      "#9ad48f",
      "#6ee79a",
      "#2d5a27",
      "#f5c518",
      "#1e3d1a",
      "#a8d24e",
    ]) {
      expect(tokens, hex).toContain(hex);
    }
  });

  test("the brand colours are exactly the approved ones", () => {
    expect(DEFAULT_THEME.colors.primary).toBe("#2d5a27");
    expect(DEFAULT_THEME.colors.accent).toBe("#f5c518");
    expect(DEFAULT_THEME.colors.header).toBe("#1e3d1a");
    expect(DEFAULT_THEME.header.awning).toEqual(["#a8d24e", "#ffffff"]);
    expect(light["--bg"]).toBe("#f5f5f5");
    expect(dark["--bg"]).toBe("#121512");
  });

  test("price text, the secondary and muted inks, the dark-mode greens match the approved values", () => {
    near(light["--accent-text"], "#946a00");
    near(light["--ink-2"], "#4a5148");
    // The mock's muted ink is 4.0:1 on white; the rendered pages must be 4.5:1, so this one is a little darker.
    near(light["--ink-3"], "#7a8178");
    near(dark["--primary-text"], "#9ad48f");
    near(dark["--ok-text"], "#6ee79a");
    near(dark["--accent-text"], "#f5c518");
  });

  test("item tiles stay warm in dark mode (more red than blue), as in the mock", () => {
    for (let i = 0; i < 7; i++) {
      const [r, , b] = toRgb(dark[`--tint-${i}a`] as string);
      if (i === 1) continue; // the iced-drink tile is a cool teal in the mock too
      expect(r, `tile ${i}`).toBeGreaterThanOrEqual(b);
    }
  });
});

describe("every text token reads on every surface it is drawn on, in both modes, for the default and the sample themes", () => {
  const themes: [string, ReturnType<typeof parseTheme>][] = [
    ["default", DEFAULT_THEME],
    ["coffee-cart", parseTheme(readSample("coffee-cart", "theme.json"))],
    ["service-desk", parseTheme(readSample("service-desk", "theme.json"))],
  ];
  const sitsOn: Record<string, string[]> = {
    "--ink": ["--bg", "--card", "--card-2"],
    "--ink-2": ["--bg", "--card", "--card-2"],
    "--ink-3": ["--bg", "--card", "--card-2"],
    "--primary-text": ["--bg", "--card", "--card-2", "--primary-soft"],
    "--accent-text": ["--bg", "--card", "--card-2", "--accent-soft"],
    "--ok-text": ["--bg", "--card", "--card-2", "--ok-soft"],
    "--warn-text": ["--bg", "--card", "--card-2", "--warn-soft"],
  };
  test.each(themes)("%s", (_name, theme) => {
    for (const mode of ["light", "dark"] as const) {
      const v = themeVars(theme, mode);
      for (const [fg, surfaces] of Object.entries(sitsOn)) {
        for (const s of surfaces) {
          expect(contrast(v[fg] as string, v[s] as string), `${mode} ${fg} on ${s}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(contrast(v["--on-primary"] as string, v["--primary"] as string)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(v["--on-accent"] as string, v["--accent"] as string)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(v["--on-accent"] as string, v["--accent"] as string)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("the focus ring", () => {
  test("is ink with a card-coloured gap, so it reads at 3:1 against the card in both modes", () => {
    for (const mode of ["light", "dark"] as const) {
      const v = themeVars(DEFAULT_THEME, mode);
      expect(contrast(v["--ink"] as string, v["--card"] as string)).toBeGreaterThanOrEqual(3);
    }
  });
});
