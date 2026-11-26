/**
 * On a demo install the sign-in screens say which throwaway PINs to use (D-035), and fill them in so a visitor signs in
 * with one tap (D-098). `GET /api/demo` holds them only on a demo and says `{demo: false}` otherwise, so on a real
 * install the note stays empty, nothing is filled in, and no PIN is ever in the page.
 */

import { api } from "./api.ts";
import { type Child, h } from "./dom.ts";

export interface DemoInfo {
  demo: true;
  staff: { id: string; pin: string; role: string }[];
  owner: { pin: string };
  admin: { pin: string };
}

let asked: Promise<DemoInfo | undefined> | undefined;

/** The demo's sign-ins, asked once per page; undefined on a real install or when the server can't be reached. */
export function demoInfo(): Promise<DemoInfo | undefined> {
  asked ??= api<DemoInfo | { demo: false }>("GET", "/api/demo")
    .then((info) => (info.demo === true ? info : undefined))
    .catch(() => undefined);
  return asked;
}

const roleLabel = (role: string) => (role === "station" ? "Stations" : role === "manager" ? "Manager" : "Counter");

/** What the staff or owner sign-in screen shows for a demo install's PINs. */
export function demoNoteText(info: DemoInfo, screen: "staff" | "owner" | "admin"): string {
  if (screen === "owner") return `Demo owner PIN: ${info.owner.pin}. This PIN works for the demo only.`;
  const who = info.staff.map((s) => `${roleLabel(s.role)}: ID ${s.id}, PIN ${s.pin}`);
  if (screen === "admin") {
    return `Demo sign-in. Owner: ID owner, PIN ${info.owner.pin}. Admin: ID admin, PIN ${info.admin.pin}. ${who.join(". ")}. These PINs work for the demo only.`;
  }
  return `Demo sign-in. ${who.join(". ")}. These PINs work for the demo only.`;
}

/**
 * An empty paragraph that fills itself on a demo install and stays empty (and hidden) otherwise. `onDemo` runs once the
 * demo's PINs are known: it fills the form in, and may return more to show under the note (a choice of role).
 */
export function demoNote(screen: "staff" | "owner" | "admin", onDemo?: (info: DemoInfo) => Child): HTMLElement {
  const text = h("span", {});
  const note = h("div", { class: "demo-note", role: "note", hidden: true }, text);
  void demoInfo().then((info) => {
    if (info === undefined) return;
    text.textContent = demoNoteText(info, screen);
    const more = onDemo?.(info);
    if (more !== undefined && more !== false && more !== null) {
      note.append(h("div", { class: "demo-roles" }, h("span", {}, "Or sign in as"), more));
    }
    note.hidden = false;
  });
  return note;
}

/** One button per demo staff sign-in ("Counter", "Stations", "Manager"); a tap signs in as that role. */
export function demoRoles(info: DemoInfo, pick: (s: DemoInfo["staff"][number]) => void): Child[] {
  return info.staff.map((s) =>
    h(
      "button",
      {
        type: "button",
        class: "demo-role",
        "aria-label": `Sign in as ${roleLabel(s.role)}`,
        "data-testid": `demo-as-${s.id}`,
        on: { click: () => pick(s) },
      },
      roleLabel(s.role),
    ),
  );
}
