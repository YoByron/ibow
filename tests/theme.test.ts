import { describe, expect, test } from "vitest";
import { ConfigError } from "../src/core/config.ts";
import {
  applyOverride,
  bestOn,
  checkContrast,
  contrast,
  DEFAULT_THEME,
  mix,
  parseTheme,
  readable,
  themeCss,
  themeImages,
  themeVars,
} from "../src/core/theme.ts";

function errorOf(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e;
    throw e;
  }
  throw new Error("expected a ConfigError");
}

describe("theme validation", () => {
  test("an empty theme is the approved green and yellow look", () => {
    expect(parseTheme({})).toEqual(DEFAULT_THEME);
  });

  test("a partial theme changes only what it names; short hex is expanded", () => {
    const t = parseTheme({ colors: { primary: "#fff", light: { surface: "#FAF3E6" } }, radius: "soft" });
    expect(t.colors.primary).toBe("#ffffff");
    expect(t.colors.light).toEqual({ surface: "#faf3e6", text: "#151a14" });
    expect(t.colors.accent).toBe(DEFAULT_THEME.colors.accent);
    expect(t.radius).toBe("soft");
  });

  test("errors name the file, the field path, what was expected and what was found", () => {
    const cases: [object, string][] = [
      [{ colors: { primary: "green" } }, "colors.primary"],
      [{ colors: { dark: { text: 5 } } }, "colors.dark.text"],
      [{ font: "comic" }, "font"],
      [{ radius: "pointy" }, "radius"],
      [{ density: "tight" }, "density"],
      [{ header: { style: "neon" } }, "header.style"],
      [{ header: { awning: ["#fff"] } }, "header.awning"],
      [{ header: { awning: ["#fff", "red"] } }, "header.awning[1]"],
      [{ header: { style: "image" } }, "header.image"],
      [{ logo: "../etc/passwd.png" }, "logo"],
      [{ categoryIcons: { tea: "nope" } }, "categoryIcons.tea"],
      [{ features: { tags: "some" } }, "features.tags"],
      [{ features: { veg: "yes" } }, "features.veg"],
      [{ colour: {} }, "colour"],
      [{ colors: { primry: "#fff" } }, "colors.primry"],
    ];
    for (const [raw, field] of cases) {
      const e = errorOf(() => parseTheme(raw, "theme.json"));
      expect(e.field, JSON.stringify(raw)).toBe(field);
      expect(e.message).toMatch(/^theme\.json: .*: expected .*, found /);
    }
  });

  test("icons come from the bundled set; images are config files or https URLs", () => {
    const t = parseTheme({
      logo: "logo.png",
      categoryIcons: { tea: "hot_beverage", cake: "https://img.example.com/cake.webp" },
      header: { style: "image", image: "banner.jpg" },
    });
    expect(t.logo).toEqual({ image: "logo.png" });
    expect(t.categoryIcons).toEqual({
      tea: { icon: "hot_beverage" },
      cake: { image: "https://img.example.com/cake.webp" },
    });
    expect(themeImages(t).sort()).toEqual(["banner.jpg", "https://img.example.com/cake.webp", "logo.png"]);
    expect(errorOf(() => parseTheme({ logo: "http://x.test/a.png" })).field).toBe("logo");
  });
});

describe("overrides (the Appearance screen)", () => {
  test("an override lands on the config's theme and is validated as a whole", () => {
    const base = parseTheme({ font: "lora", logo: "hot_beverage" });
    const t = applyOverride(base, { colors: { accent: "#ff0000" }, features: { favourites: false } });
    expect(t.colors.accent).toBe("#ff0000");
    expect(t.colors.primary).toBe(base.colors.primary);
    expect(t.font).toBe("lora");
    expect(t.features.favourites).toBe(false);
    expect(t.features.recent).toBe(true);
    expect(base.colors.accent).toBe(DEFAULT_THEME.colors.accent);
  });

  test("it can't touch what the screen doesn't edit, and bad values name their path", () => {
    expect(errorOf(() => applyOverride(DEFAULT_THEME, { categoryIcons: { a: "bell" } })).field).toBe("categoryIcons");
    expect(errorOf(() => applyOverride(DEFAULT_THEME, { header: { image: "a.png" } })).field).toBe("header.image");
    expect(errorOf(() => applyOverride(DEFAULT_THEME, { colors: { primary: "x" } })).field).toBe("colors.primary");
  });
});

describe("colour derivation and contrast", () => {
  test("WCAG ratios: black on white is 21, equal colours 1", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#777777")).toBeCloseTo(1, 5);
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
  });

  test("readable pulls a colour toward black or white until it reads, and leaves a good one alone", () => {
    expect(readable("#111111", "#ffffff")).toBe("#111111");
    expect(contrast(readable("#f5c518", "#ffffff"), "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(readable("#2d5a27", "#121512"), "#121512")).toBeGreaterThanOrEqual(4.5);
  });

  test("on-colours always pass for any brand colour", () => {
    for (const c of ["#f5c518", "#2d5a27", "#808080", "#ff00ff", "#1d6fd1", "#00ff00", "#7f7f00", "#6f6f00"]) {
      expect(contrast(bestOn(c), c), c).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("the default theme passes every check; a pale-on-pale pair is flagged with its ratio", () => {
    expect(checkContrast(DEFAULT_THEME).every((c) => c.ok)).toBe(true);
    const bad = parseTheme({ colors: { light: { surface: "#ffffff", text: "#bbbbbb" } } });
    const fails = checkContrast(bad).filter((c) => !c.ok);
    expect(fails).toHaveLength(1);
    expect(fails[0]).toMatchObject({ pair: "Text on the page, light mode", min: 4.5 });
    expect(fails[0]?.ratio).toBeLessThan(2);
  });

  test("every derived text token reads on its card in both modes, whatever the brand", () => {
    const blue = parseTheme({ colors: { primary: "#1d6fd1", accent: "#ffd23f", header: "#0b3a6b" } });
    for (const t of [DEFAULT_THEME, blue]) {
      for (const mode of ["light", "dark"] as const) {
        const v = themeVars(t, mode);
        for (const k of ["--ink-3", "--primary-text", "--accent-text", "--ok-text", "--warn-text"]) {
          expect(contrast(v[k] as string, v["--card"] as string), `${mode} ${k}`).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrast(v["--on-primary"] as string, v["--primary"] as string)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(v["--on-accent"] as string, v["--accent"] as string)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe("theme.css", () => {
  test("holds light tokens, dark by the system or by data-theme, and only the chosen font's face", () => {
    const css = themeCss(parseTheme({ font: "lora", radius: "sharp", density: "compact" }));
    expect(css).toContain("--primary:#2d5a27");
    expect(css).toContain("@media (prefers-color-scheme:dark){:root:not([data-theme=light])");
    expect(css).toContain(":root[data-theme=dark]{");
    expect(css).toContain('font-family:"ibow-lora"');
    expect(css).not.toContain("ibow-inter");
    expect(css).toContain("--r-card:2px");
    expect(css).toContain("--sp-4:12px");
    expect(themeCss(parseTheme({ font: "system" }))).not.toContain("@font-face");
  });

  test("a different theme gives different tokens; the same theme the same bytes", () => {
    const a = themeCss(DEFAULT_THEME);
    expect(themeCss(parseTheme({}))).toBe(a);
    expect(themeCss(parseTheme({ colors: { primary: "#1d6fd1" } }))).not.toBe(a);
  });

  test("a header image becomes a custom property through the given resolver", () => {
    const css = themeCss(parseTheme({ header: { style: "image", image: "banner.jpg" } }), (r) => `/media/${r}`);
    expect(css).toContain('--hdr-image:url("/media/banner.jpg")');
  });
});

describe("the premium layer (D-070)", () => {
  test("a display face, photo-only tiles and the featured strip are opt-in, and their values are checked", () => {
    const d = parseTheme({});
    expect(d.display).toBeUndefined();
    expect(d.features.tiles).toBe("always");
    expect(d.features.featured).toBe(false);
    const t = parseTheme({ font: "inter", display: "fraunces", features: { tiles: "photos", featured: true } });
    expect(t.display).toBe("fraunces");
    expect(t.features).toMatchObject({ tiles: "photos", featured: true });
    expect(() => parseTheme({ display: "comic" })).toThrow(/display/);
    expect(() => parseTheme({ features: { tiles: "sometimes" } })).toThrow(/features\.tiles/);
  });

  test("theme.css loads the display face once beside the body face and names it --font-display", () => {
    const css = themeCss(parseTheme({ font: "inter", display: "fraunces" }));
    expect(css).toContain('font-family:"ibow-fraunces"');
    expect(css).toContain('font-family:"ibow-inter"');
    expect(css).toMatch(/--font-display:"ibow-fraunces", Georgia/);
    expect(themeCss(parseTheme({ font: "lora" })).match(/@font-face/g)).toHaveLength(1);
  });
});
