/**
 * On a demo install the sign-in screens say which throwaway PINs to use (D-035). `GET /api/demo` holds them only on a
 * demo and says `{demo: false}` otherwise, so on a real install the note stays empty and no PIN is ever in the page.
 */

import { api } from "./api.ts";
import { h } from "./dom.ts";

export interface DemoInfo {
  demo: true;
  staff: { id: string; pin: string; role: string }[];
  owner: { pin: string };
  admin: { pin: string };
}

/** What the staff or owner sign-in screen shows for a demo install's PINs. */
export function demoNoteText(info: DemoInfo, screen: "staff" | "owner" | "admin"): string {
  if (screen === "owner") return `Demo owner PIN: ${info.owner.pin}. This PIN works for the demo only.`;
  const label = (role: string) => (role === "station" ? "Stations" : role === "manager" ? "Manager" : "Counter");
  const who = info.staff.map((s) => `${label(s.role)}: ID ${s.id}, PIN ${s.pin}`);
  if (screen === "admin") {
    return `Demo sign-in. Owner: ID owner, PIN ${info.owner.pin}. Admin: ID admin, PIN ${info.admin.pin}. ${who.join(". ")}. These PINs work for the demo only.`;
  }
  return `Demo sign-in. ${who.join(". ")}. These PINs work for the demo only.`;
}

/** An empty paragraph that fills itself on a demo install and stays empty (and hidden) otherwise. */
export function demoNote(screen: "staff" | "owner" | "admin"): HTMLElement {
  const note = h("p", { class: "demo-note", role: "note", hidden: true });
  api<DemoInfo>("GET", "/api/demo")
    .then((info) => {
      if (info.demo !== true) return;
      note.textContent = demoNoteText(info, screen);
      note.hidden = false;
    })
    .catch(() => {});
  return note;
}
