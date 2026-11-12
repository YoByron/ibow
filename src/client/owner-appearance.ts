/**
 * The owner's Appearance screen: edit the theme's colours, typeface, corners, spacing, header, logo icon and toggles,
 * see a phone-sized preview of the real storefront components with the owner's own menu, get a warning before saving
 * colours that are hard to read (WCAG AA), save over the config's theme or reset to it. The preview sets the same
 * custom properties `/theme.css` carries, on the frame alone, so nothing here touches the page around it.
 */

import { formatPrice } from "../core/money.ts";
import { baseVars, checkContrast, type FontId, ICONS, type Theme, themeVars } from "../core/theme.ts";
import { api } from "./api.ts";
import { type Child, h, mount } from "./dom.ts";
import { t } from "./owner-strings.ts";
import { t as tStore, useStrings } from "./strings.ts";
import { badge } from "./ui/chip.ts";
import { appHeader } from "./ui/header.ts";
import { icon, iconRef } from "./ui/icon.ts";
import { tabBar } from "./ui/tabbar.ts";
import type { ThemeInfo } from "./ui/theme-client.ts";

interface ThemeState {
  base: Theme;
  effective: Theme;
  overridden: boolean;
}

interface PreviewCatalog {
  business: { name: string; currency: string };
  categories: {
    id: string;
    name: string;
    icon?: string;
    items: {
      id: string;
      name: string;
      icon?: string;
      description?: string;
      tags?: string[];
      price?: number;
      variants?: { price: number }[];
    }[];
  }[];
}

const FONT_LABELS: [FontId, () => string][] = [
  ["inter", () => t("fontInter")],
  ["lora", () => t("fontLora")],
  ["nunito", () => t("fontNunito")],
  ["space-grotesk", () => t("fontSpace")],
  ["system", () => t("fontSystem")],
];

/** The override the screen saves: every field it edits, taken from the draft. */
export function overrideOf(draft: Theme, logo: string | undefined): Record<string, unknown> {
  return {
    colors: draft.colors,
    font: draft.font,
    radius: draft.radius,
    density: draft.density,
    header: { style: draft.header.style, awning: draft.header.awning },
    ...(logo === undefined ? {} : { logo }),
    features: draft.features,
  };
}

export async function appearanceView(
  show: (...children: Child[]) => void,
  failureText: (e: unknown) => string,
): Promise<void> {
  const [state, catalog, live] = await Promise.all([
    api<ThemeState>("GET", "/api/owner/theme"),
    api<PreviewCatalog>("GET", "/api/catalog"),
    api<ThemeInfo>("GET", "/api/theme"),
  ]);
  // The preview reads exactly like the storefront: its own labels, with this install's overrides for the owner's language.
  useStrings(live.strings, navigator.language);
  const storeT = tStore;
  let draft: Theme = structuredClone(state.effective);
  let overridden = state.overridden;
  let logo: string | undefined;
  let mode: "light" | "dark" = "light";
  let acknowledged = false;
  const message = h("p", { role: "status" });
  const warnings = h("div");
  const frame = h("div", { class: "preview", "aria-label": t("previewTitle"), role: "img" });
  const saveBtn = h("button", { type: "button", class: "primary" }, t("save"));
  const resetBtn = h("button", { type: "button", class: "secondary" }, t("resetToConfig"));
  const money = (minor: number) => formatPrice(minor, catalog.business.currency, navigator.language);

  // ── Preview: the storefront's own components on a sample of the owner's menu ────────────────────────────────────

  function drawPreview(): void {
    const vars = { ...baseVars(draft), ...themeVars(draft, mode) };
    for (const [k, v] of Object.entries(vars)) frame.style.setProperty(k, v);
    const cats = catalog.categories.slice(0, 2);
    const first = catalog.categories[0];
    const items = first?.items.slice(0, 2) ?? [];
    const lowest = (i: (typeof items)[number]) =>
      i.price ?? Math.min(...(i.variants ?? [{ price: 0 }]).map((v) => v.price));
    const highest = (i: (typeof items)[number]) =>
      i.price ?? Math.max(...(i.variants ?? [{ price: 0 }]).map((v) => v.price));
    const logoRef = logo ? { icon: logo } : draft.logo;
    const tagOf = (it: (typeof items)[number]): string | undefined => {
      if (draft.features.tags === "off") return undefined;
      const computed = draft.features.tags === "auto" ? live.popular[it.id] : undefined;
      if (computed === "bestseller") return storeT("tagBestseller");
      if (computed === "popular") return storeT("tagPopular");
      return it.tags?.[0];
    };
    const iconOf = (it: (typeof items)[number], cat: PreviewCatalog["categories"][number] | undefined) =>
      it.icon ?? cat?.icon ?? "fork_and_knife_with_plate";
    const total = items.reduce((n, it) => n + lowest(it), 0);
    mount(
      frame,
      h(
        "div",
        { class: "shell bare" },
        appHeader({
          title: catalog.business.name,
          subtitle: storeT("tagline"),
          style: draft.header.style === "image" ? "plain" : draft.header.style,
          logo: logoRef,
          actions: [draft.features.darkToggle && h("span", { class: "rbtn" }, icon("crescent_moon"))],
          below: h("div", { class: "search" }, icon("magnifying_glass_tilted_left"), storeT("search")),
        }),
        h(
          "div",
          { class: "rail" },
          h("span", { class: "pill", "aria-pressed": "true" }, storeT("allCategories")),
          ...cats.map((c) =>
            h("span", { class: "pill has-icon" }, iconRef({ icon: c.icon ?? "fork_and_knife_with_plate" }), c.name),
          ),
        ),
        ...items.map((it, i) => {
          const tag = tagOf(it);
          return h(
            "article",
            { class: "item" },
            h(
              "div",
              { class: "tx" },
              tag && h("span", { class: "tag no-icon" }, tag),
              h("h3", {}, it.name, draft.features.veg && i === 0 && h("span", { class: "diet veg" })),
              h(
                "div",
                { class: "price num" },
                lowest(it) === highest(it) ? money(lowest(it)) : `${money(lowest(it))} – ${money(highest(it))}`,
                it.variants && h("small", {}, storeT("sizesCount", { n: String(it.variants.length) })),
              ),
              it.description && h("p", { class: "desc" }, it.description),
            ),
            h(
              "div",
              { class: "pic-wrap" },
              h("div", { class: `pic t-${i}` }, iconRef({ icon: iconOf(it, first) })),
              h("div", { class: "ctl" }, h("span", { class: "add" }, storeT("add"), h("i", {}, "+"))),
            ),
          );
        }),
        h(
          "div",
          { class: "cartbar" },
          h("span", { class: "bag" }, icon("shopping_cart")),
          h(
            "div",
            { class: "l" },
            h("small", {}, storeT("itemsInCart", { n: String(items.length) })),
            h("b", { class: "num" }, money(total)),
          ),
          draft.features.cartEta &&
            live.etaMinutes !== undefined &&
            h("span", { class: "eta" }, storeT("etaAbout", { n: String(live.etaMinutes) })),
          h("span", { class: "go" }, storeT("reviewOrder"), " ›"),
        ),
        tabBar(
          [
            { id: "a", label: storeT("tabMenu"), icon: icon("clipboard"), href: "#/appearance" },
            { id: "b", label: storeT("tabCart"), icon: icon("shopping_cart"), href: "#/appearance" },
            { id: "c", label: storeT("tabTrack"), icon: icon("ticket"), href: "#/appearance" },
          ],
          "a",
          t("previewTitle"),
        ),
      ),
    );
    frame.dataset.mode = mode;
  }

  function drawWarnings(): void {
    const bad = checkContrast(draft).filter((c) => !c.ok);
    mount(
      warnings,
      h("h3", {}, t("contrastTitle")),
      bad.length === 0
        ? h("p", { class: "hint", "data-testid": "contrast-ok" }, t("contrastOk"))
        : h(
            "div",
            { role: "alert", class: "contrast-bad", "data-testid": "contrast-bad" },
            h("p", {}, t("contrastWarn")),
            h(
              "ul",
              { class: "plain" },
              ...bad.map((c) =>
                h("li", {}, t("contrastBad", { pair: c.pair, ratio: String(c.ratio), min: String(c.min) })),
              ),
            ),
          ),
    );
    saveBtn.textContent = bad.length === 0 || acknowledged ? t("save") : t("saveAnyway");
    resetBtn.disabled = !overridden;
  }

  function changed(): void {
    acknowledged = false;
    message.textContent = "";
    drawPreview();
    drawWarnings();
  }

  // ── Controls ─────────────────────────────────────────────────────────────────────────────────────────────────────

  const colour = (label: string, get: () => string, set: (v: string) => void) => {
    const input = h("input", { type: "color", value: get(), "aria-label": label });
    input.addEventListener("input", () => {
      set(input.value);
      changed();
    });
    return h("label", { class: "swatch" }, input, h("span", {}, label));
  };
  const choice = <T extends string>(label: string, options: [T, string][], get: () => T, set: (v: T) => void) => {
    const select = h(
      "select",
      { "aria-label": label },
      ...options.map(([v, text]) => h("option", { value: v, selected: v === get() }, text)),
    );
    select.addEventListener("change", () => {
      set(select.value as T);
      changed();
    });
    return h("label", { class: "field" }, label, select);
  };
  const toggle = (label: string, get: () => boolean, set: (v: boolean) => void) => {
    const box = h("input", { type: "checkbox", checked: get() });
    box.addEventListener("change", () => {
      set(box.checked);
      changed();
    });
    return h("label", { class: "check" }, box, h("span", {}, label));
  };

  const c = () => draft.colors;
  const headerChoices: [Theme["header"]["style"], string][] = [
    ["awning", t("headerAwning")],
    ["plain", t("headerPlain")],
    ...(state.base.header.image === undefined
      ? []
      : ([["image", t("headerImage")]] as [Theme["header"]["style"], string][])),
  ];
  const awningColours = h("div", { class: "swatches" });
  const drawAwning = () =>
    mount(
      awningColours,
      draft.header.style === "awning" && [
        colour(
          t("colAwningA"),
          () => draft.header.awning[0],
          (v) => {
            draft.header.awning[0] = v;
          },
        ),
        colour(
          t("colAwningB"),
          () => draft.header.awning[1],
          (v) => {
            draft.header.awning[1] = v;
          },
        ),
      ],
    );

  const form = h(
    "div",
    { class: "appearance-form" },
    h(
      "section",
      { class: "card" },
      h("h2", {}, t("colours")),
      h(
        "div",
        { class: "swatches" },
        colour(
          t("colPrimary"),
          () => c().primary,
          (v) => {
            c().primary = v;
          },
        ),
        colour(
          t("colAccent"),
          () => c().accent,
          (v) => {
            c().accent = v;
          },
        ),
        colour(
          t("colHeader"),
          () => c().header,
          (v) => {
            c().header = v;
          },
        ),
        colour(
          t("colLightSurface"),
          () => c().light.surface,
          (v) => {
            c().light.surface = v;
          },
        ),
        colour(
          t("colLightText"),
          () => c().light.text,
          (v) => {
            c().light.text = v;
          },
        ),
        colour(
          t("colDarkSurface"),
          () => c().dark.surface,
          (v) => {
            c().dark.surface = v;
          },
        ),
        colour(
          t("colDarkText"),
          () => c().dark.text,
          (v) => {
            c().dark.text = v;
          },
        ),
      ),
      warnings,
    ),
    h(
      "section",
      { class: "card" },
      choice(
        t("fontLabel"),
        FONT_LABELS.map(([v, l]) => [v, l()] as [FontId, string]),
        () => draft.font,
        (v) => {
          draft.font = v;
        },
      ),
      choice(
        t("radiusLabel"),
        [
          ["sharp", t("radiusSharp")],
          ["soft", t("radiusSoft")],
          ["round", t("radiusRound")],
        ],
        () => draft.radius,
        (v) => {
          draft.radius = v;
        },
      ),
      choice(
        t("densityLabel"),
        [
          ["comfortable", t("densityComfortable")],
          ["compact", t("densityCompact")],
        ],
        () => draft.density,
        (v) => {
          draft.density = v;
        },
      ),
      choice(
        t("headerLabel"),
        headerChoices,
        () => draft.header.style,
        (v) => {
          draft.header.style = v;
          drawAwning();
        },
      ),
      awningColours,
      choice(
        t("logoLabel"),
        [["", t("logoConfig")], ...ICONS.map((i) => [i, i.replace(/_/g, " ")] as [string, string])],
        () => logo ?? "",
        (v) => {
          logo = v === "" ? undefined : v;
        },
      ),
    ),
    h(
      "section",
      { class: "card" },
      h("h2", {}, t("features")),
      toggle(
        t("featFavourites"),
        () => draft.features.favourites,
        (v) => {
          draft.features.favourites = v;
        },
      ),
      toggle(
        t("featRecent"),
        () => draft.features.recent,
        (v) => {
          draft.features.recent = v;
        },
      ),
      toggle(
        t("featVeg"),
        () => draft.features.veg,
        (v) => {
          draft.features.veg = v;
        },
      ),
      toggle(
        t("featDark"),
        () => draft.features.darkToggle,
        (v) => {
          draft.features.darkToggle = v;
        },
      ),
      toggle(
        t("featEta"),
        () => draft.features.cartEta,
        (v) => {
          draft.features.cartEta = v;
        },
      ),
      choice(
        t("featTags"),
        [
          ["off", t("tagsOff")],
          ["catalog", t("tagsCatalog")],
          ["auto", t("tagsAuto")],
        ],
        () => draft.features.tags,
        (v) => {
          draft.features.tags = v;
        },
      ),
    ),
    h("div", { class: "row" }, saveBtn, resetBtn),
    message,
  );

  async function put(): Promise<void> {
    const bad = checkContrast(draft).some((x) => !x.ok);
    if (bad && !acknowledged) {
      // The first press only warns (the warning is already on screen); the second saves what the owner chose.
      acknowledged = true;
      saveBtn.textContent = t("save");
      return;
    }
    saveBtn.disabled = true;
    try {
      const next = await api<ThemeState>("PUT", "/api/owner/theme", { body: overrideOf(draft, logo) });
      overridden = next.overridden;
      draft = structuredClone(next.effective);
      message.textContent = t("saved");
      drawWarnings();
    } catch (e) {
      message.textContent = failureText(e);
    } finally {
      saveBtn.disabled = false;
    }
  }
  saveBtn.addEventListener("click", () => void put());
  resetBtn.addEventListener("click", async () => {
    try {
      const next = await api<ThemeState>("DELETE", "/api/owner/theme");
      overridden = next.overridden;
      draft = structuredClone(next.effective);
      logo = undefined;
      message.textContent = t("resetDone");
      show(...view());
    } catch (e) {
      message.textContent = failureText(e);
    }
  });

  const modeButtons = (["light", "dark"] as const).map((m) => {
    const b = h(
      "button",
      { type: "button", class: "chip", "aria-pressed": String(mode === m) },
      m === "light" ? t("previewLight") : t("previewDark"),
    );
    b.addEventListener("click", () => {
      mode = m;
      for (const x of modeButtons) x.setAttribute("aria-pressed", String(x === b));
      drawPreview();
    });
    return b;
  });

  function view(): Child[] {
    drawAwning();
    drawPreview();
    drawWarnings();
    return [
      h(
        "p",
        { class: "hint" },
        t("appearanceHint"),
        " ",
        badge(overridden ? t("usingOverride") : t("usingConfig"), overridden ? "accent" : "gray"),
      ),
      h(
        "div",
        { class: "appearance" },
        form,
        h("aside", { class: "preview-col" }, h("div", { class: "chips" }, ...modeButtons), frame),
      ),
    ];
  }
  try {
    show(...view());
  } catch (e) {
    show(h("p", { class: "error", role: "alert" }, failureText(e)));
  }
}
