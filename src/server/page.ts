/** What every host of the built client shares, Node (`static.ts`) or Workers (`src/worker`): headers, manifest, AI script. */

/** No inline script or style, no third party but the https image hosts the config names: the rest comes from this server. */
export function contentSecurityPolicy(imageOrigins: readonly string[] = []): string {
  return [
    "default-src 'self'",
    `img-src 'self' data:${imageOrigins.map((o) => ` ${o}`).join("")}`,
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
}

/** The policy of an install whose config names no image host. */
export const CSP = contentSecurityPolicy();

/** The AI analyst's own bundle (M7): linked from the owner's page and served only when AI is on (D-028). */
export const ANALYST_SCRIPT = "/owner-ai.js";

/** The headers every file of the client carries. */
export function fileHeaders(build: string): Record<string, string> {
  return {
    // Revalidate every load; the service worker serves from its cache when the network is slow or gone.
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-ibow-build": build,
  };
}

/** The default theme's header colour, the manifest's and the page's until a look says otherwise. */
export const DEFAULT_THEME_COLOR = "#1e3d1a";

/** The web app manifest, so the storefront installs under the business's own name. */
export function manifest(name: string, themeColor = DEFAULT_THEME_COLOR): string {
  const icon = (size: number, purpose: string) => ({
    src: `/icon-${size}.png`,
    sizes: `${size}x${size}`,
    type: "image/png",
    purpose,
  });
  return JSON.stringify({
    name,
    short_name: name,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f6f7f6",
    theme_color: themeColor,
    icons: [icon(192, "any"), icon(512, "any"), icon(192, "maskable"), icon(512, "maskable")],
  });
}

/** The storefront of a demo install, with a visible "Demo" label above the app (it needs no script or inline style). */
export function withDemoLabel(html: string): string {
  if (!html.includes("<body>")) throw new Error("ibow: expected <body> in the built index.html, found none");
  const label =
    '<p class="hint" role="note"><strong>Demo</strong>: sample data and throwaway PINs. Nothing here is a real order.</p>';
  return html.replace("<body>", `<body>${label}`);
}

/** The owner's page with the analyst's script added after its own, so it runs once the dashboard has started. */
export function withAnalystScript(html: string): string {
  if (!html.includes("</head>")) throw new Error("ibow: expected </head> in the built owner.html, found none");
  return html.replace("</head>", `<script src="${ANALYST_SCRIPT}" defer></script></head>`);
}
