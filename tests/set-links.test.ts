/** `npm run set-links`: validation of each address, the replacement everywhere, and the command line itself. */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { applyLinks, checkLink, parseArgs, placeholder, replacements } from "../scripts/set-links.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tree(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), "ibow-links-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

const ALL = {
  linkedin: "https://www.linkedin.com/in/someone",
  instagram: "https://www.instagram.com/someone/",
  demo: "https://ibow-demo.someone.workers.dev/",
  repo: "https://github.com/someone/ibow",
};

describe("checkLink", () => {
  test("accepts https addresses on the right site, subdomains included", () => {
    expect(checkLink("linkedin", "https://www.linkedin.com/in/x")).toBe("https://www.linkedin.com/in/x");
    expect(checkLink("linkedin", "https://in.linkedin.com/in/x")).toContain("in.linkedin.com");
    expect(checkLink("instagram", "https://instagram.com/x")).toBe("https://instagram.com/x");
    expect(checkLink("repo", "https://github.com/a/b")).toBe("https://github.com/a/b");
    expect(checkLink("demo", "https://anything.example.net/path")).toBe("https://anything.example.net/path");
    // A trailing slash is dropped from the demo address, so the showcase address has one slash.
    expect(checkLink("demo", "https://demo.example.net/")).toBe("https://demo.example.net");
    expect(checkLink("demo", "https://demo.example.net/app/")).toBe("https://demo.example.net/app");
  });

  test.each([
    ["linkedin", "http://www.linkedin.com/in/x", "https://"],
    ["linkedin", "https://evil-linkedin.com/in/x", "linkedin.com"],
    ["linkedin", "https://linkedin.com.evil.net/in/x", "linkedin.com"],
    ["linkedin", "https://www.instagram.com/x", "linkedin.com"],
    ["instagram", "https://github.com/x", "instagram.com"],
    ["repo", "https://gitlab.com/a/b", "github.com"],
    ["repo", "https://github.com/onlyowner", "<owner>/<repo>"],
    ["demo", "http://demo.example.org", "https://"],
    ["demo", "ftp://demo.example.org", "https://"],
    ["demo", "not a url", "https address"],
    ["demo", "https://demo.example.org/?x=1", "query or fragment"],
    ["demo", "https://demo.example.org/#top", "query or fragment"],
    ["demo", "https://demo.example.org?", "query or fragment"],
    ["demo", 'https://demo.example.org/"onmouseover="x', "quotes"],
    ["demo", "https://user:pw@demo.example.org", "credentials"],
    ["repo", "https://github.com/a/b)(x", "brackets"],
  ] as const)("refuses --%s %s", (kind, value, why) => {
    expect(() => checkLink(kind, value)).toThrow(why);
  });
});

describe("replacements", () => {
  test("the showcase is the demo plus /showcase, with one slash", () => {
    const r = replacements(ALL);
    expect(r.get(placeholder("SHOWCASE"))).toBe("https://ibow-demo.someone.workers.dev/showcase");
    expect(r.get(placeholder("DEMO"))).toBe("https://ibow-demo.someone.workers.dev");
    expect([...r.keys()].sort()).toEqual(
      ["DEMO", "INSTAGRAM", "LINKEDIN", "REPO", "SHOWCASE"].map((n) => `{{${n}_URL}}`),
    );
  });
});

describe("applyLinks", () => {
  test("replaces every placeholder in every text file, nested ones included, and leaves binaries and skipped folders", () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0]), Buffer.from(placeholder("REPO"))]);
    const dir = tree({
      "README.md": `${placeholder("LINKEDIN")} and ${placeholder("LINKEDIN")}, ${placeholder("INSTAGRAM")}\n`,
      "src/client/page.html": `<a href="${placeholder("SHOWCASE")}">${placeholder("DEMO")}</a> ${placeholder("REPO")}\n`,
      "img.png": png,
      "node_modules/x/readme.md": `${placeholder("REPO")}\n`,
      "plain.txt": "nothing to do\n",
    });
    const changed = applyLinks(dir, ALL);
    expect(changed).toEqual(["README.md", "src/client/page.html"]);
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe(
      "https://www.linkedin.com/in/someone and https://www.linkedin.com/in/someone, https://www.instagram.com/someone/\n",
    );
    expect(readFileSync(join(dir, "src/client/page.html"), "utf8")).toBe(
      '<a href="https://ibow-demo.someone.workers.dev/showcase">https://ibow-demo.someone.workers.dev</a> https://github.com/someone/ibow\n',
    );
    expect(readFileSync(join(dir, "img.png")).equals(png)).toBe(true);
    expect(readFileSync(join(dir, "node_modules/x/readme.md"), "utf8")).toContain(placeholder("REPO"));
  });

  test("writes nothing when any address is invalid", () => {
    const dir = tree({ "a.md": `${placeholder("LINKEDIN")} ${placeholder("DEMO")}\n` });
    expect(() => applyLinks(dir, { demo: "https://ok.example.org", linkedin: "https://example.org/in/x" })).toThrow(
      "linkedin.com",
    );
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe(`${placeholder("LINKEDIN")} ${placeholder("DEMO")}\n`);
  });

  test("keeps line endings and is a no-op the second time", () => {
    const dir = tree({ "a.md": `x ${placeholder("REPO")}\r\ny\r\n` });
    expect(applyLinks(dir, ALL)).toEqual(["a.md"]);
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("x https://github.com/someone/ibow\r\ny\r\n");
    expect(applyLinks(dir, ALL)).toEqual([]);
  });
});

describe("the command", () => {
  test("parses the four options and refuses anything else", () => {
    expect(parseArgs(["--linkedin", "a", "--demo", "b"])).toEqual({ linkedin: "a", demo: "b" });
    expect(() => parseArgs([])).toThrow("at least one");
    expect(() => parseArgs(["--email", "x"])).toThrow("--linkedin, --instagram, --demo or --repo");
    expect(() => parseArgs(["--demo"])).toThrow("followed by an https address");
    expect(() => parseArgs(["--demo", "--repo", "x"])).toThrow("followed by an https address");
  });

  test("exits 1 with a message for a bad address, without touching the repo", () => {
    const before = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
    const res = spawnSync(process.execPath, ["scripts/set-links.ts", "--linkedin", "https://example.org/in/x"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("expected --linkedin on linkedin.com");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })).toBe(before);
  });
});
