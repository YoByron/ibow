// Builds the client into dist/client: the storefront, the staff page, the owner's dashboard and its AI analyst panel (a minified script each), the stylesheets,
// two icons and the service worker, whose cache name is a hash of everything else so a new build replaces the old cache.
//   npm run build
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync, gzipSync } from "node:zlib";
import { build } from "esbuild";
import { DEFAULT_THEME, themeCss } from "../src/core/theme.ts";
import { contentSecurityPolicy, fileHeaders } from "../src/server/page.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const src = join(root, "src/client");
export const CLIENT_DIR = join(root, "dist/client");
/** Old phones still in use run browsers from about 2020 (Chrome 80, Safari 14). */
const TARGET = ["es2020"];
/** The brand colour of the icon: the default theme's primary (the icon is made at build time, so it does not follow a theme). */
/** The pictures of the showcase page, copied from docs/media (the one place the approved screenshots live). */
export const SHOWCASE_MEDIA = [
  "storefront.png",
  "size-sheet.png",
  "cart.png",
  "token.png",
  "pin.png",
  "counter.png",
  "counter-cash.png",
  "station.png",
  "rush.gif",
  "owner.png",
  "appearance.png",
  "themed-coffee-cart.png",
  "themed-service-desk.png",
];
const ICON_RGB = [0x2d, 0x5a, 0x27] as const;

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

/** A square PNG: the brand colour edge to edge (safe as a maskable icon) with a white ring, a token, in the middle. */
export function iconPng(size: number): Buffer {
  const rows: Buffer[] = [];
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x + 0.5 - c, y + 0.5 - c) / size;
      const white = r <= 0.26 && r >= 0.15;
      const px = white ? [255, 255, 255] : ICON_RGB;
      row.set(px, 1 + x * 3);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Every file under `dir`, as paths relative to it with forward slashes, sorted. */
function listFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const p = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...listFiles(dir, p));
    else out.push(p);
  }
  return out.sort();
}

export interface BuiltFile {
  name: string;
  bytes: number;
  gzipBytes: number;
}

/**
 * The `_headers` file Cloudflare's static assets read: the same headers the Node server sends (`src/server/page.ts`).
 * Node's `loadClient` skips it, as it has no known type. The owner's page and the manifest run the Worker, which sets
 * their headers itself, since `_headers` doesn't apply to responses a Worker makes.
 */
export function assetHeaders(build: string, imageOrigins: readonly string[] = []): string {
  const rule = (path: string, headers: Record<string, string>) =>
    [path, ...Object.entries(headers).map(([k, v]) => `  ${k}: ${v}`)].join("\n");
  const csp = contentSecurityPolicy(imageOrigins);
  const pages = [
    "/",
    "/staff",
    "/showcase",
    "/index.html",
    "/staff.html",
    "/showcase.html",
    "/owner.html",
    "/admin",
    "/admin.html",
  ];
  const rules = [rule("/*", fileHeaders(build)), ...pages.map((p) => rule(p, { "Content-Security-Policy": csp }))];
  return `${rules.join("\n\n")}\n`;
}

/** A page's `href="/x.css"` and `src="/x.js"` as `…?b=<build>`; a reference that already has a query is left alone. */
export function stampAssets(html: string, build: string): string {
  return html.replace(
    /(\s(?:href|src)=")(\/[\w./-]+\.(?:js|css))(")/g,
    (_, a: string, path: string, z: string) => `${a}${path}?b=${build}${z}`,
  );
}

export interface BuildOptions {
  /** The https image hosts the config names; they join the content security policy of the pages' `_headers` (Workers). */
  imageOrigins?: readonly string[];
}

export async function buildClient(target = CLIENT_DIR, opts: BuildOptions = {}): Promise<BuiltFile[]> {
  // Built beside the target and swapped in at the end, so a server booting meanwhile never finds a half-built folder.
  const outDir = `${target}.building-${process.pid}`;
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const common = {
    bundle: true,
    minify: true,
    target: TARGET,
    logLevel: "warning" as const,
    legalComments: "eof" as const,
    // Typefaces are served from /assets at runtime, not bundled into the stylesheet.
    external: ["/assets/*"],
  };
  await build({ ...common, entryPoints: [join(src, "app.ts")], outfile: join(outDir, "app.js"), format: "iife" });
  await build({ ...common, entryPoints: [join(src, "staff.ts")], outfile: join(outDir, "staff.js"), format: "iife" });
  await build({ ...common, entryPoints: [join(src, "style.css")], outfile: join(outDir, "style.css") });
  await build({ ...common, entryPoints: [join(src, "store.css")], outfile: join(outDir, "store.css") });
  await build({ ...common, entryPoints: [join(src, "staff.css")], outfile: join(outDir, "staff.css") });
  // The owner's dashboard: its own script and styles, and no service worker (it is used online, by one person).
  await build({ ...common, entryPoints: [join(src, "owner.ts")], outfile: join(outDir, "owner.js"), format: "iife" });
  await build({ ...common, entryPoints: [join(src, "owner.css")], outfile: join(outDir, "owner.css") });
  // The links hub, the switches and the health page (D-074 to D-076): one more page, its own script, no service worker.
  await build({ ...common, entryPoints: [join(src, "admin.ts")], outfile: join(outDir, "admin.js"), format: "iife" });
  await build({ ...common, entryPoints: [join(src, "admin.css")], outfile: join(outDir, "admin.css") });
  copyFileSync(join(src, "admin.html"), join(outDir, "admin.html"));
  // The showcase page (D-055): static, styled by the theme tokens, its pictures the approved screenshots in docs/media.
  await build({ ...common, entryPoints: [join(src, "showcase.css")], outfile: join(outDir, "showcase.css") });
  mkdirSync(join(outDir, "showcase"));
  for (const name of SHOWCASE_MEDIA) copyFileSync(join(root, "docs/media", name), join(outDir, "showcase", name));
  copyFileSync(join(src, "showcase.html"), join(outDir, "showcase.html"));
  // The AI analyst's panel (M7): its own script, which the server links and serves only when AI is on (D-028).
  await build({
    ...common,
    entryPoints: [join(src, "owner-ai.ts")],
    outfile: join(outDir, "owner-ai.js"),
    format: "iife",
  });
  // Icons and typefaces, self-hosted: the worker caches them as they are first used.
  cpSync(join(src, "assets"), join(outDir, "assets"), { recursive: true });
  copyFileSync(join(src, "owner.html"), join(outDir, "owner.html"));
  copyFileSync(join(src, "index.html"), join(outDir, "index.html"));
  copyFileSync(join(src, "staff.html"), join(outDir, "staff.html"));
  writeFileSync(join(outDir, "icon-192.png"), iconPng(192));
  writeFileSync(join(outDir, "icon-512.png"), iconPng(512));

  const hash = createHash("sha256");
  for (const name of listFiles(outDir)) hash.update(name).update(readFileSync(join(outDir, name)));
  // The manifest is generated by the server from business.json; the worker caches it like any other file.
  const version = hash.digest("hex").slice(0, 12);
  // The server sends this as X-Ibow-Build on every file; the worker caches only responses from its own build.
  writeFileSync(join(outDir, "build.txt"), `${version}\n`);
  // Every page names its scripts and sheets with the build (`/app.js?b=…`), so a cache in front of the server (Cloudflare's
  // browser TTL turns our no-cache into four hours) can never pair one build's page with another build's files.
  for (const page of listFiles(outDir).filter((n) => n.endsWith(".html"))) {
    const file = join(outDir, page);
    writeFileSync(file, stampAssets(readFileSync(file, "utf8"), version));
  }
  // One worker per page, each precaching only its own files: a customer's phone never downloads the staff screens.
  const workers = [
    {
      out: "sw.js",
      page: "/",
      name: "store",
      assets: ["/", "/app.js", "/theme.css", "/style.css", "/store.css", "/icon-192.png", "/manifest.webmanifest"],
    },
    {
      out: "staff-sw.js",
      page: "/staff",
      name: "staff",
      assets: ["/staff", "/staff.js", "/theme.css", "/style.css", "/staff.css", "/icon-192.png"],
    },
  ];
  for (const w of workers) {
    await build({
      ...common,
      entryPoints: [join(src, "sw.ts")],
      outfile: join(outDir, w.out),
      format: "iife",
      define: {
        BUILD_VERSION: JSON.stringify(version),
        BUILD_ASSETS: JSON.stringify(w.assets),
        BUILD_PAGE: JSON.stringify(w.page),
        BUILD_CACHE: JSON.stringify(`ibow-${w.name}-`),
      },
    });
  }

  writeFileSync(join(outDir, "_headers"), assetHeaders(version, opts.imageOrigins));

  const built = listFiles(outDir).map((name) => {
    const body = readFileSync(join(outDir, name));
    return { name, bytes: body.length, gzipBytes: gzipSync(body, { level: 9 }).length };
  });
  rmSync(target, { recursive: true, force: true });
  renameSync(outDir, target);
  return built;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // `--look <bundle.json>` (from scripts/bundle-look.ts): the image hosts it names join the pages' content security policy.
  const at = process.argv.indexOf("--look");
  const imageOrigins =
    at < 0
      ? []
      : (JSON.parse(readFileSync(process.argv[at + 1] as string, "utf8")) as { imageOrigins: string[] }).imageOrigins;
  const files = await buildClient(CLIENT_DIR, { imageOrigins });
  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`.padStart(9);
  for (const f of files) console.log(`${f.name.padEnd(16)}${kb(f.bytes)}${kb(f.gzipBytes)} gzip`);
  const first = files.filter((f) => ["index.html", "app.js", "style.css", "store.css"].includes(f.name));
  const theme = gzipSync(themeCss(DEFAULT_THEME), { level: 9 }).length;
  console.log(
    `first load (page, script, styles, theme.css): ${kb(first.reduce((n, f) => n + f.gzipBytes, theme)).trim()} gzip, fonts and images apart`,
  );
}
