/**
 * The install guide: what docs/install.md and wrangler.toml point at exists, Docker is gone, and the server needs
 * nothing outside `src/`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (f: string) => readFileSync(join(root, f), "utf8");

test("the server imports nothing from outside src/", () => {
  const files = (readdirSync(join(root, "src"), { recursive: true }) as string[]).filter((f) => f.endsWith(".ts"));
  const src = resolve(root, "src");
  for (const f of files) {
    const path = join(src, f);
    for (const [, spec] of read(join("src", f)).matchAll(/from "(\.[^"]+)"/g)) {
      const target = resolve(dirname(path), spec as string);
      expect(target.startsWith(src), `${f} imports ${spec}`).toBe(true);
    }
  }
});

test("docs/install.md names only scripts and npm commands that exist", () => {
  const guide = read("docs/install.md");
  const scripts = [...guide.matchAll(/scripts\/[\w.-]+\.(?:ts|sh)/g)].map((m) => m[0]);
  expect(scripts).toContain("scripts/backup.ts");
  for (const s of scripts) expect(existsSync(join(root, s)), s).toBe(true);
  const npm = JSON.parse(read("package.json")).scripts as Record<string, string>;
  for (const [, name] of guide.matchAll(/npm run ([\w-]+)/g))
    expect(npm[name as string], `npm run ${name}`).toBeDefined();
});

test("Docker is gone: no image files, and neither the guide nor the README tells anyone to use it", () => {
  for (const f of ["Dockerfile", "compose.yaml", ".dockerignore"]) expect(existsSync(join(root, f)), f).toBe(false);
  for (const f of ["docs/install.md", "README.md", ".env.example"]) expect(read(f), f).not.toMatch(/docker/i);
});

test("wrangler.toml and wrangler.demo.toml point at files that exist and bundle the same Worker", () => {
  for (const file of ["wrangler.toml", "wrangler.demo.toml"]) {
    const text = read(file);
    expect(text, file).toContain('main = "src/worker/index.ts"');
    expect(existsSync(join(root, "src/worker/index.ts"))).toBe(true);
    for (const [, path] of text.matchAll(/^ibow-\w+ = "\.\/([^"]+)"/gm)) {
      // config/ is the owner's own and dist/ is made by the build command below; everything else must exist.
      if (!/^(config|dist)\//.test(path as string)) expect(existsSync(join(root, path as string)), path).toBe(true);
    }
    // The build command bundles the look to the very file the alias names, then builds the client with its image hosts.
    const [, look] = text.match(/^ibow-look = "\.\/([^"]+)"/m) ?? [];
    expect(look, file).toBeDefined();
    expect(text, file).toContain(`scripts/bundle-look.ts`);
    expect(text, file).toContain(` ${look} &&`);
    expect(text, file).toContain(`--look ${look}"`);
  }
  expect(read("wrangler.demo.toml")).toContain('DEMO = "1"');
  expect(read("wrangler.toml")).not.toContain("DEMO");
});
