/**
 * The AI analyst's panel on the owner's dashboard (M7, D-028): its own bundle, which the server links from
 * `owner.html` only when AI is on, so the dashboard itself carries none of it. It asks this server, never a model, and
 * shows the answer as text with the figures it cited. It sits below `#app`, on the Today page while the owner is
 * signed in, so the dashboard's redraws never wipe a typed question.
 */

import { ApiFailure, api } from "./api.ts";
import { h, mount } from "./dom.ts";
import { t } from "./owner-ai-strings.ts";
import { markUnbacked } from "./owner-ai-view.ts";

interface Figure {
  key: string;
  label: string;
  value: string;
}

interface Answer {
  text: string;
  figures: Figure[];
  unverified: string[];
  grounded: boolean;
}

function failureText(e: unknown): string {
  if (!(e instanceof ApiFailure)) return t("failed", { message: String(e) });
  if (e.code === "network") return t("offline");
  if (e.code === "rate_limited") return t("tooMany");
  if (e.status === 401) return t("signedOut");
  return t("failed", { message: e.message });
}

const app = document.getElementById("app") as HTMLElement;
const output = h("div", { "aria-live": "polite", "data-testid": "analyst-answer" });
const input = h("input", {
  name: "question",
  type: "text",
  maxlength: 500,
  required: true,
  autocomplete: "off",
  placeholder: t("placeholder"),
});
const button = h("button", { type: "submit", class: "primary" }, t("ask"));
const form = h("form", { class: "login" }, h("label", {}, t("question"), input), button);
const panel = h(
  "section",
  { class: "analyst", "aria-labelledby": "analyst-title", hidden: true },
  h("h2", { id: "analyst-title" }, t("title")),
  h("p", { class: "hint" }, t("privacy")),
  form,
  output,
);
// Layout through the CSSOM, which the strict CSP allows (no style attribute, no extra stylesheet to link).
Object.assign(panel.style, { maxWidth: "40rem", margin: "0 auto", padding: "0 1rem 1rem" });
app.after(panel);

/** An unbacked number, marked in the answer's text (a styled element built through the DOM, never HTML). */
function unbacked(text: string): HTMLElement {
  const mark = h("mark", { class: "unbacked", title: t("unbackedMark") }, text);
  Object.assign(mark.style, { fontWeight: "700", textDecoration: "underline wavy", padding: "0 0.15em" });
  return mark;
}

function show(answer: Answer): void {
  mount(
    output,
    // The warning comes first, so it is read before the answer it qualifies.
    !answer.grounded &&
      h("p", { class: "error", role: "alert" }, t("unverified", { numbers: answer.unverified.join(", ") })),
    h(
      "p",
      { class: "summary-box" },
      ...markUnbacked(answer.text, answer.unverified).map((s) => (s.unbacked ? unbacked(s.text) : s.text)),
    ),
    answer.figures.length > 0 && h("h3", {}, t("used")),
    answer.figures.length > 0 &&
      h(
        "ul",
        { class: "plain" },
        ...answer.figures.map((f) => h("li", {}, t("figure", { label: f.label, value: f.value }))),
      ),
  );
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = input.value.trim();
  if (question === "") return;
  button.disabled = true;
  button.textContent = t("asking");
  mount(output);
  try {
    const r = await api<{ answer: Answer }>("POST", "/api/owner/ask", { body: { question } });
    show(r.answer);
  } catch (err) {
    mount(output, h("p", { class: "error", role: "alert" }, failureText(err)));
  } finally {
    button.disabled = false;
    button.textContent = t("ask");
  }
});

/** Shown on the Today page while the dashboard (its navigation) is up, so not on the sign-in screen. */
function place(): void {
  const today = location.hash === "" || location.hash === "#/";
  panel.hidden = !(today && app.querySelector(".owner-nav") !== null);
}

new MutationObserver(place).observe(app, { childList: true });
window.addEventListener("hashchange", place);
place();
