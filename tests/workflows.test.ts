/** The GitHub workflows: pinned, least-privilege, no secret on a command line, and the export keeps and passes them. */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { pruneExport, scanTree } from "../scripts/release-scan.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (f: string) => readFileSync(join(root, f), "utf8");
const FILES = [".github/workflows/ci.yml"];

test.each(FILES)("%s exists, with no tabs and a name", (file) => {
  expect(existsSync(join(root, file)), file).toBe(true);
  const text = read(file);
  expect(text).not.toContain("\t");
  expect(text).toMatch(/^name: \S/m);
});

test.each(FILES)(
  "%s pins every action to a full commit SHA with its version in a comment, and asks for read-only permissions",
  (file) => {
    const text = read(file);
    const uses = [...text.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/gm)];
    expect(uses.length).toBeGreaterThan(0);
    for (const m of uses) {
      expect(m[1], `${file}: ${m[0]}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      expect(m[2], `${file}: ${m[0]}`).toMatch(/#\s*v\d/);
    }
    expect(text).toMatch(/^permissions:\n\s+contents: read\n/m);
    expect(text).not.toMatch(/(contents|actions|packages|id-token|pull-requests): write/);
  },
);

test("ci.yml runs on pull requests and pushes to main: Node from .node-version, cached npm, the gate, then the browser tests", () => {
  const text = read(".github/workflows/ci.yml");
  expect(text).toMatch(/^name: CI$/m);
  expect(text).toMatch(/^\s+pull_request:/m);
  expect(text).toMatch(/^\s+push:\n\s+branches: \[main\]/m);
  expect(text).toContain("node-version-file: .node-version");
  expect(text).toContain("cache: npm");
  const order = ["npm ci", "npm run gate", "npx playwright install --with-deps chromium", "npm run e2e"].map((s) =>
    text.indexOf(s),
  );
  expect(
    order.every((i) => i >= 0),
    "every step is present",
  ).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
});

test("a secret is only ever read into an env entry, never put on a command line or echoed", () => {
  for (const file of FILES) {
    for (const line of read(file).split("\n")) {
      if (!line.includes("${{ secrets.")) continue;
      expect(line, `${file}: ${line}`).toMatch(/^\s+[A-Z_]+: \$\{\{ secrets\.[A-Z_]+ \}\}\s*$/);
    }
    expect(read(file)).not.toMatch(/echo[^\n]*\$\{?(CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID)/);
  }
});

test("there is no push-based deploy workflow: the demo is pulled by the server (D-059)", () => {
  expect(existsSync(join(root, ".github/workflows/deploy-demo.yml"))).toBe(false);
});

test("the demo bundle holds no real config: wrangler.demo.toml reads samples and its own look only", () => {
  const toml = read("wrangler.demo.toml");
  expect(toml).not.toMatch(/\.\/config\b|\bconfig\//);
  expect(toml).toContain('ibow-business = "./samples/tea-house/business.json"');
  expect(toml).toContain("bundle-look.ts samples/tea-house dist/look-demo.json");
});

test("the release export keeps .github and passes its scans", () => {
  const out = mkdtempSync(join(tmpdir(), "ibow-gh-"));
  try {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
    for (const f of [...new Set([...files, ...FILES])].filter((f) => existsSync(join(root, f)))) {
      mkdirSync(dirname(join(out, f)), { recursive: true });
      writeFileSync(join(out, f), readFileSync(join(root, f)));
    }
    expect(pruneExport(out).filter((p) => p.startsWith(".github"))).toEqual([]);
    for (const f of FILES) expect(existsSync(join(out, f)), f).toBe(true);
    const mine = scanTree(out, { export: true, commit: false, files: FILES });
    expect(mine).toEqual([]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 120_000);
