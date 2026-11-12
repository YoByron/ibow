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
}

/** What the staff or owner sign-in screen shows for a demo install's PINs. */
export function demoNoteText(info: DemoInfo, screen: "staff" | "owner"): string {
  if (screen === "owner") return `Demo owner PIN: ${info.owner.pin}. This PIN works for the demo only.`;
  const who = info.staff.map((s) => `${s.role === "station" ? "Stations" : "Counter"}: ID ${s.id}, PIN ${s.pin}`);
  return `Demo sign-in. ${who.join(". ")}. These PINs work for the demo only.`;
}

/** An empty paragraph that fills itself on a demo install and stays empty (and hidden) otherwise. */
export function demoNote(screen: "staff" | "owner"): HTMLElement {
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
