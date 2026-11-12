/**
 * The Worker (D-030): static files come from the assets binding without running this code; what does run is `/api/*`,
 * forwarded to the one Durable Object of the install, `/theme.css` (the look in force, which the owner's Appearance
 * changes), and the few pages that depend on configuration (the manifest carries the business's name and colour; the
 * owner's page gets the AI script only when AI is on). The config's images are served from the bundle, no object needed.
 */

import { aiSettings } from "../ai/model.ts";
import {
  ANALYST_SCRIPT,
  contentSecurityPolicy,
  fileHeaders,
  manifest,
  withAnalystScript,
  withDemoLabel,
} from "../server/page.ts";
import { mediaHeaders } from "../server/theme.ts";
import { config, demoBundle, looks } from "./config.ts";
import { type Bindings, strings } from "./env.ts";
import { CLIENT_IP_HEADER } from "./install.ts";

export { Install } from "./install.ts";

let build: Promise<string> | undefined;
function buildId(env: Bindings): Promise<string> {
  build ??= env.ASSETS.fetch(new Request("https://assets.invalid/build.txt")).then(async (r) =>
    r.ok ? (await r.text()).trim() : "unknown",
  );
  return build;
}

const INSTALL = "install";
/** The showcase page and everything it loads; the Worker runs first for these (`/showcase*` in wrangler.toml). */
const isShowcasePath = (p: string) => p === "/showcase" || p.startsWith("/showcase.") || p.startsWith("/showcase/");
/** The policy of every page, with the https image hosts the config names (the static pages get it from `_headers`). */
const CSP = contentSecurityPolicy(looks.imageOrigins);

export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    const url = new URL(request.url);
    const install = () => env.INSTALL.get(env.INSTALL.idFromName(INSTALL));
    if (url.pathname.startsWith("/api/")) {
      const headers = new Headers(request.headers);
      headers.delete(CLIENT_IP_HEADER);
      const ip = request.headers.get("cf-connecting-ip");
      if (ip) headers.set(CLIENT_IP_HEADER, ip);
      return install().fetch(new Request(request, { headers }));
    }
    if (url.pathname === "/theme.css") {
      // The object knows the look in force; the build id is the assets', so the service worker keeps it with its own build.
      const res = await install().fetch(request);
      const headers = new Headers(res.headers);
      if (res.ok || res.status === 304) headers.set("x-ibow-build", await buildId(env));
      return new Response(res.body, { status: res.status, headers });
    }
    if (url.pathname.startsWith("/media/")) {
      const file = looks.media.get(decodeURIComponent(url.pathname.slice("/media/".length)));
      if (file === undefined) return new Response("not found", { status: 404 });
      return new Response(new Uint8Array(file.body).buffer, { headers: mediaHeaders(file, await buildId(env)) });
    }
    const fileFor = async (type: string, body: BodyInit | null, extra: Record<string, string> = {}) =>
      new Response(body, { headers: { "content-type": type, ...fileHeaders(await buildId(env)), ...extra } });
    if (url.pathname === "/manifest.webmanifest") {
      const color = await install().fetch(new Request(new URL("/__header-color", url)));
      return fileFor(
        "application/manifest+json",
        manifest(config.business.name, color.ok ? await color.text() : looks.theme.colors.header),
      );
    }
    // A demo ignores AI_* (D-040), so its owner page never links the analyst's script.
    const ai = env.DEMO !== "1" && aiSettings(strings(env)) !== undefined;
    if (url.pathname === ANALYST_SCRIPT && !ai) return new Response("not found", { status: 404 });
    // Every customer page of a demo carries a "Demo" label: the storefront and the token page are this one page.
    if (demoBundle && env.DEMO === "1" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const page = await env.ASSETS.fetch(new Request(new URL("/", url)));
      if (!page.ok) return page;
      return fileFor("text/html; charset=utf-8", withDemoLabel(await page.text()), { "content-security-policy": CSP });
    }
    if (isShowcasePath(url.pathname)) {
      // A demo shows it by default; a real install only with `showcase: true` in business.json (D-055).
      const on = (demoBundle && env.DEMO === "1") || config.business.showcase === true;
      return on ? env.ASSETS.fetch(request) : new Response("not found", { status: 404 });
    }
    if (url.pathname === "/owner") {
      const page = await env.ASSETS.fetch(new Request(new URL("/owner", url)));
      if (!page.ok) return page;
      const html = await page.text();
      return fileFor("text/html; charset=utf-8", ai ? withAnalystScript(html) : html, {
        "content-security-policy": CSP,
      });
    }
    return env.ASSETS.fetch(request);
  },
};
