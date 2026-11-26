/**
 * The links hub at `/admin` (D-074), with the switches (D-075) and the install's health (D-076) behind it. One page for
 * every level: signed out it offers the sign-in choices, signed in it lists only the screens that level may open, which the
 * server decides (`GET /api/hub`), so this file knows no level's powers.
 */

import type { Health } from "../core/health.ts";
import { t } from "./admin-strings.ts";
import { ApiFailure, api } from "./api.ts";
import { demoInfo, demoNote } from "./demo-note.ts";
import { type Child, h, mount } from "./dom.ts";
import { eventCardSlot, reloadEvents, showSplashEvent } from "./events.ts";
import { roundButton, button as uiButton } from "./ui/button.ts";
import { quickCard } from "./ui/card.ts";
import { appHeader } from "./ui/header.ts";
import { icon } from "./ui/icon.ts";
import { keypad } from "./ui/keypad.ts";
import { transition, watchBoot } from "./ui/shell.ts";
import { stat } from "./ui/stat.ts";
import { FALLBACK, initMode, loadThemeInfo, type ThemeInfo, toggleMode, watchTheme } from "./ui/theme-client.ts";

watchBoot();
showSplashEvent();

const root = document.getElementById("app") as HTMLElement;
const locale = navigator.language;
let theme: ThemeInfo = FALLBACK;
let businessName = "ibow";

type Group = "everyone" | "staff" | "manager" | "owner" | "admin";
interface Hub {
  user: string | null;
  level: "staff" | "manager" | "owner" | "admin" | null;
  groups: { group: Group; links: { id: string; href: string; title: string; what: string }[] }[];
}

interface FlagRow {
  key: string;
  scope: "look" | "system";
  kind: "boolean" | "number" | "choice";
  what: string;
  value: boolean | number | string;
  choices?: string[];
  min?: number;
  max?: number;
  note?: string;
}
interface AuditRow {
  id: number;
  at: number;
  by: string;
  level: string;
  key: string;
  from: boolean | number | string | null;
  to: boolean | number | string;
}
interface HealthReport extends Health {
  build: string;
  startedAt: number;
  uptimeMs: number;
  openStreams: number;
  databaseBytes: number;
  lastBackup: { at: number; source: "backup" | "export" } | null;
  now: number;
  verdict: { ok: boolean; concerns: ("errors" | "rows" | "size")[] };
}

function failureText(e: unknown): string {
  if (!(e instanceof ApiFailure)) return t("failed");
  if (e.code === "network") return t("offline");
  if (e.code === "bad_pin") return t("badPin");
  if (e.code === "rate_limited") return t("tooManyTries");
  return `${t("failed")} (${e.code})`;
}

const levelName = (level: string) =>
  level === "admin"
    ? t("levelAdmin")
    : level === "owner"
      ? t("levelOwner")
      : level === "manager"
        ? t("levelManager")
        : t("levelStaff");

const levelHint = (level: string) =>
  level === "admin"
    ? t("levelAdminHint")
    : level === "owner"
      ? t("levelOwnerHint")
      : level === "manager"
        ? t("levelManagerHint")
        : t("levelStaffHint");

const groupName = (g: Group) =>
  g === "everyone"
    ? t("everyone")
    : g === "staff"
      ? t("groupstaff")
      : g === "manager"
        ? t("groupmanager")
        : g === "owner"
          ? t("groupowner")
          : t("groupadmin");

const groupIcon = (g: Group) =>
  g === "everyone"
    ? "teacup_without_handle"
    : g === "staff"
      ? "clipboard"
      : g === "manager"
        ? "bento_box"
        : g === "owner"
          ? "chart_increasing"
          : "locked";

const time = (at: number) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(at);

function shell(hub: Hub | undefined, ...body: Child[]): void {
  mount(
    root,
    appHeader({
      title: t("title"),
      titleHref: "#/",
      subtitle: hub?.user ? t("signedInAs", { user: hub.user, level: levelName(hub.level ?? "staff") }) : businessName,
      style: theme.header.style,
      logo: theme.logo,
      actions: [
        theme.features.darkToggle && roundButton("Dark", icon("crescent_moon"), () => void toggleMode()),
        hub?.user
          ? roundButton(t("signOut"), icon("locked"), async () => {
              await api("POST", "/api/logout").catch(() => undefined);
              void route();
            })
          : false,
      ],
    }),
    h("main", { class: "admin" }, ...body),
  );
}

// ── Sign in ────────────────────────────────────────────────────────────────────────────────────────────────────────

function signIn(hub: Hub): void {
  const choices: { level: "staff" | "manager" | "owner" | "admin"; fixed?: string }[] = [
    { level: "staff" },
    { level: "manager" },
    { level: "owner", fixed: "owner" },
    { level: "admin", fixed: "admin" },
  ];
  shell(
    hub,
    h("h2", {}, t("chooseLevel")),
    demoNote("admin"),
    h(
      "div",
      { class: "choices" },
      ...choices.map((c) =>
        h(
          "button",
          {
            type: "button",
            class: c.level === "staff" ? "tile main" : "tile",
            "data-testid": `level-${c.level}`,
            "aria-label": levelName(c.level),
            on: { click: () => form(c) },
          },
          h("span", { class: "tile-ic", "aria-hidden": "true" }, icon(groupIcon(c.level))),
          h("span", { class: "tile-tx" }, h("b", {}, levelName(c.level)), h("small", {}, levelHint(c.level))),
          h("span", { class: "tile-go", "aria-hidden": "true" }, "›"),
        ),
      ),
    ),
    ...hub.groups.flatMap((g) => links(g)),
  );

  function form(c: (typeof choices)[number]): void {
    const error = h("p", { class: "error", role: "alert" });
    const id = h("input", { name: "user", autocomplete: "username", autocapitalize: "none", required: true });
    const pin = h("input", {
      name: "pin",
      type: "password",
      inputmode: "numeric",
      autocomplete: "current-password",
      required: true,
    });
    const pad = keypad({
      max: 12,
      input: pin,
      labels: { clear: t("pinClear"), delete: t("pinDelete"), digit: (n) => n },
      onChange: () => {
        error.textContent = "";
      },
      onEnter: () => f.requestSubmit(),
    });
    const f = h(
      "form",
      { class: "login", "data-testid": `signin-${c.level}` },
      c.fixed === undefined && h("label", {}, t("staffId"), id),
      h("label", { class: "sr-only" }, t("pin"), pin),
      pad.el,
      uiButton({ kind: "accent", type: "submit" }, t("signIn")),
      error,
    );
    // A demo fills in this level's sign-in, so a visitor only taps Sign in (D-098).
    void demoInfo().then((info) => {
      if (info === undefined || pad.value() !== "") return;
      const s =
        c.level === "staff" ? info.staff.find((x) => x.role === "counter") : info.staff.find((x) => x.role === c.level);
      const p = c.level === "owner" ? info.owner.pin : c.level === "admin" ? info.admin.pin : s?.pin;
      if (s !== undefined && c.fixed === undefined && id.value === "") id.value = s.id;
      if (p !== undefined) pad.fill(p);
    });
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      error.textContent = "";
      try {
        await api("POST", "/api/login", { body: { user: c.fixed ?? id.value.trim(), pin: pin.value } });
        const now = await api<Hub>("GET", "/api/hub");
        // A staff ID that is not a manager must not pass for one, nor the reverse.
        if (now.level !== c.level) {
          await api("POST", "/api/logout").catch(() => undefined);
          pad.clear();
          error.textContent = t("wrongLevel", { level: levelName(c.level) });
          return;
        }
        void route();
      } catch (err) {
        pad.clear();
        error.textContent = failureText(err);
      }
    });
    shell(hub, h("h2", {}, levelName(c.level)), f, uiButton({ kind: "link", onClick: () => signIn(hub) }, t("back")));
  }
}

// ── The hub ────────────────────────────────────────────────────────────────────────────────────────────────────────

function links(g: Hub["groups"][number]): Child[] {
  return [
    h(
      "section",
      { class: "hub-group", "data-testid": `group-${g.group}` },
      h("h2", {}, groupName(g.group)),
      h(
        "div",
        { class: "hub-grid" },
        ...g.links.map((l) =>
          quickCard({
            icon: icon(groupIcon(g.group)),
            title: l.title,
            hint: l.what,
            href: l.href,
            testid: `link-${l.id}`,
          }),
        ),
      ),
    ),
  ];
}

function hubView(hub: Hub): void {
  shell(
    hub,
    eventCardSlot(),
    ...(hub.groups.length === 0 ? [h("p", { class: "hint" }, t("nothingHere"))] : hub.groups.flatMap(links)),
  );
}

// ── Switches ───────────────────────────────────────────────────────────────────────────────────────────────────────

const show = (v: FlagRow["value"] | null) =>
  v === null ? t("unset") : v === true ? t("switchOn") : v === false ? t("switchOff") : String(v);

async function switchesView(hub: Hub): Promise<void> {
  const data = await api<{ flags: FlagRow[]; audit: AuditRow[] }>("GET", "/api/flags");
  const error = h("p", { class: "error", role: "alert" });
  const put = async (key: string, value: FlagRow["value"]) => {
    error.textContent = "";
    try {
      await api("PUT", `/api/flags/${encodeURIComponent(key)}`, { body: { value } });
      await switchesView(hub);
    } catch (e) {
      error.textContent = failureText(e);
    }
  };
  const control = (f: FlagRow): Child => {
    if (f.kind === "boolean") {
      const on = f.value === true;
      return uiButton(
        { kind: on ? "primary" : "ghost", testid: `flag-${f.key}`, onClick: () => void put(f.key, !on) },
        on ? t("switchOn") : t("switchOff"),
      );
    }
    if (f.kind === "choice") {
      const select = h(
        "select",
        {
          "aria-label": f.key,
          "data-testid": `flag-${f.key}`,
          on: { change: () => void put(f.key, select.value) },
        },
        ...(f.choices ?? []).map((c) => h("option", { value: c, selected: c === f.value }, c)),
      );
      return select;
    }
    const box = h("input", {
      type: "number",
      inputmode: "numeric",
      min: String(f.min ?? 0),
      max: String(f.max ?? ""),
      value: String(f.value),
      "aria-label": f.key,
      "data-testid": `flag-${f.key}`,
    });
    return h(
      "span",
      { class: "row" },
      box,
      uiButton({ kind: "ghost", onClick: () => void put(f.key, Number(box.value)) }, t("setValue")),
    );
  };
  shell(
    hub,
    h("a", { class: "back", href: "#/" }, t("back")),
    h("h2", {}, t("switches")),
    error,
    ...data.flags.map((f) =>
      h(
        "div",
        { class: "flag" },
        h("b", {}, f.key),
        h("p", { class: "hint" }, f.what, f.note !== undefined && ` ${f.note}`),
        h("div", { class: "row" }, control(f)),
      ),
    ),
    h("h2", {}, t("changes")),
    data.audit.length === 0
      ? h("p", { class: "hint" }, t("noChanges"))
      : h(
          "table",
          { class: "audit", "data-testid": "audit" },
          ...data.audit.map((a) =>
            h(
              "tr",
              {},
              h("td", {}, time(a.at)),
              h("td", {}, t("changeLine", { who: a.by, key: a.key, from: show(a.from), to: show(a.to) })),
            ),
          ),
        ),
  );
}

// ── Health ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function span(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 60) return t("minutes", { n: String(min) });
  if (min < 48 * 60) return t("hours", { n: String(Math.floor(min / 60)) });
  return t("days", { n: String(Math.floor(min / (24 * 60))) });
}

const bytes = (n: number) => (n < 1_000_000 ? `${Math.round(n / 1000)} KB` : `${(n / 1_000_000).toFixed(1)} MB`);

async function healthView(hub: Hub): Promise<void> {
  const r = await api<HealthReport>("GET", "/api/admin/health");
  const peak = Math.max(1, ...r.hours.map((x) => x.requests));
  const bars = h("div", { class: "bars", role: "img", "aria-label": t("lastDay") });
  for (const x of r.hours) {
    const bar = h("i", { class: x.errors > 0 ? "bad" : "", title: `${time(x.at)}: ${x.requests}` });
    bar.style.height = `${Math.max(2, Math.round((x.requests / peak) * 100))}%`;
    bars.append(bar);
  }
  const used = Math.min(100, Math.round((r.rows.writtenToday / r.rows.limit) * 100));
  const meter = h("div", { class: "meter", "aria-hidden": "true" }, h("i"));
  (meter.firstChild as HTMLElement).style.width = `${used}%`;
  const concern = (c: "errors" | "rows" | "size") =>
    c === "errors" ? t("concernErrors") : c === "rows" ? t("concernRows") : t("concernSize");
  const backup =
    r.lastBackup === null
      ? t("noBackup")
      : r.lastBackup.source === "backup"
        ? t("lastBackupBackup", { when: time(r.lastBackup.at) })
        : t("lastBackupExport", { when: time(r.lastBackup.at) });
  shell(
    hub,
    h("a", { class: "back", href: "#/" }, t("back")),
    h(
      "div",
      { class: `verdict ${r.verdict.ok ? "ok" : "warn"}`, "data-testid": "verdict", role: "status" },
      icon(r.verdict.ok ? "star" : "sparkles"),
      r.verdict.ok ? t("healthy") : `${t("lookAt")}: ${r.verdict.concerns.map(concern).join(" ")}`,
    ),
    h(
      "div",
      { class: "tiles" },
      stat({ label: t("requests"), value: String(r.requests), sub: t("lastDay"), testid: "stat-requests" }),
      stat({ label: t("errors"), value: String(r.errors), tone: r.errors > 0 ? "warn" : "ok", testid: "stat-errors" }),
      stat({ label: t("openStreams"), value: String(r.openStreams), testid: "stat-streams" }),
      stat({
        label: t("rowsToday"),
        value: r.rows.writtenToday.toLocaleString(locale),
        sub: t("rowsOf", { limit: r.rows.limit.toLocaleString(locale) }),
        testid: "stat-rows",
      }),
      stat({ label: t("dbSize"), value: bytes(r.databaseBytes), testid: "stat-size" }),
      stat({ label: t("uptime"), value: span(r.uptimeMs), sub: `${t("build")} ${r.build}`, testid: "stat-uptime" }),
    ),
    bars,
    meter,
    h("p", { class: "hint", "data-testid": "backup" }, `${t("lastBackup")}: ${backup}`),
    h("h2", {}, t("slowest")),
    r.slowest.length === 0
      ? h("p", { class: "hint" }, t("none"))
      : h(
          "ul",
          { class: "plain", "data-testid": "slowest" },
          ...r.slowest.map((s) =>
            h("li", {}, t("routeLine", { route: s.route, max: String(s.maxMs), avg: String(s.avgMs), n: String(s.n) })),
          ),
        ),
  );
}

// ── Routing ────────────────────────────────────────────────────────────────────────────────────────────────────────

let refresh: ReturnType<typeof setInterval> | undefined;

async function route(): Promise<void> {
  clearInterval(refresh);
  try {
    const hub = await api<Hub>("GET", "/api/hub");
    if (hub.level === null) return signIn(hub);
    const hash = location.hash;
    if (hash === "#/health" && hub.groups.some((g) => g.links.some((l) => l.id === "health"))) {
      await healthView(hub);
      // Kept fresh while it is open, so the page on a phone on the counter stays true.
      refresh = setInterval(() => void healthView(hub).catch(() => undefined), 30_000);
      return;
    }
    if (
      hash === "#/switches" &&
      hub.groups.some((g) => g.links.some((l) => l.id === "switches" || l.id === "system-switches"))
    ) {
      return await switchesView(hub);
    }
    hubView(hub);
  } catch (e) {
    mount(
      root,
      h(
        "main",
        { class: "admin" },
        h("p", { class: "error", role: "alert" }, failureText(e)),
        uiButton({ kind: "primary", onClick: () => void route() }, t("retry")),
      ),
    );
  }
}

async function start(): Promise<void> {
  // A sign-in adds the staff-only events.
  reloadEvents();
  initMode();
  try {
    theme = await loadThemeInfo();
    watchTheme(theme, (next) => {
      theme = next;
    });
    const catalog = await api<{ business: { name: string } }>("GET", "/api/catalog");
    businessName = catalog.business.name;
    document.title = `${t("title")} · ${businessName}`;
  } catch {
    // The hub works without the look: the defaults stand.
  }
  await route();
}

window.addEventListener("hashchange", () => transition(() => void route()));
void start();
