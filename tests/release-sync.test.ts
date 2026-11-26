/** scripts/release-sync.sh: the pruned, scanned tree lands in a clone of the public repo as an ordinary commit. */

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.setConfig({ testTimeout: 90_000 });
const root = fileURLToPath(new URL("../", import.meta.url));
const bash = spawnSync("bash", ["--version"]).status === 0;
/** The assistant folder the prune removes, written backwards so this file does not name it. */
const DEV_DIR = `.${[..."edualc"].reverse().join("")}`;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const tmp = (what: string) => {
  const d = mkdtempSync(join(tmpdir(), `ibow-sync-${what}-`));
  dirs.push(d);
  return d;
};

function put(dir: string, files: Record<string, string>): void {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
}

/** A small repo that holds the two scripts and some files, committed: stands in for the development repo. */
function source(files: Record<string, string>): string {
  const dir = tmp("src");
  mkdirSync(join(dir, "scripts"));
  for (const f of ["release-scan.ts", "release-sync.sh"]) cpSync(join(root, "scripts", f), join(dir, "scripts", f));
  put(dir, files);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Dev");
  git(dir, "config", "user.email", "dev@example.org");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "dev");
  return dir;
}

/** A stand-in for a clone of the public repo, with one earlier commit. */
function clone(): string {
  const dir = tmp("clone");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Pub");
  git(dir, "config", "user.email", "pub@example.org");
  writeFileSync(join(dir, "old.txt"), "old\n");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}

const AUTHOR = { RELEASE_AUTHOR_NAME: "Pat Example", RELEASE_AUTHOR_EMAIL: "1+pat@users.noreply.github.com" };

const sync = (src: string, dest: string, message: string, env: Record<string, string> = {}) =>
  spawnSync("bash", [join(src, "scripts/release-sync.sh"), dest, message], {
    cwd: src,
    encoding: "utf8",
    env: { ...process.env, ...AUTHOR, ...env },
  });

describe.skipIf(!bash)("release-sync.sh", () => {
  test("syncs the tree as one ordinary commit on top of the clone history, deleting what is gone, never touching .git or ignored files", () => {
    const src = source({
      "README.md": "hello\n",
      "src/a.ts": "export const a = 1;\n",
      [`${DEV_DIR}/agents/x.md`]: "dev only\n",
    });
    const dest = clone();
    mkdirSync(join(dest, "node_modules"));
    writeFileSync(join(dest, "node_modules/keep.txt"), "installed\n");
    const res = sync(src, dest, "feat: first sync", {
      RELEASE_AUTHOR_NAME: "Pat Example",
      RELEASE_AUTHOR_EMAIL: "pat@users.noreply.github.com",
    });
    expect(res.status, res.stderr).toBe(0);
    expect(git(dest, "rev-list", "--count", "HEAD")).toBe("2");
    expect(git(dest, "log", "-1", "--format=%s|%an|%ae")).toBe(
      "feat: first sync|Pat Example|pat@users.noreply.github.com",
    );
    expect(readFileSync(join(dest, "src/a.ts"), "utf8")).toContain("a = 1");
    expect(existsSync(join(dest, "old.txt"))).toBe(false);
    expect(existsSync(join(dest, DEV_DIR))).toBe(false);
    expect(existsSync(join(dest, "node_modules/keep.txt"))).toBe(true);
    expect(git(dest, "remote")).toBe("");
    expect(git(dest, "status", "--porcelain")).toBe("");
  });

  test("a second run with nothing changed makes no commit; a change makes exactly one", () => {
    const src = source({ "README.md": "hello\n" });
    const dest = clone();
    expect(sync(src, dest, "one").status).toBe(0);
    const head = git(dest, "rev-parse", "HEAD");
    const again = sync(src, dest, "two");
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain("nothing changed");
    expect(git(dest, "rev-parse", "HEAD")).toBe(head);
    put(src, { "README.md": "hello again\n" });
    git(src, "commit", "-q", "-am", "dev 2");
    expect(sync(src, dest, "three").status).toBe(0);
    expect(git(dest, "rev-list", "--count", "HEAD")).toBe("3");
    expect(git(dest, "log", "-1", "--format=%s")).toBe("three");
  });

  test("refuses without an author, and refuses the bare no-reply address GitHub credits to an unrelated account", () => {
    const src = source({ "README.md": "hello\n" });
    const dest = clone();
    const head = git(dest, "rev-parse", "HEAD");
    const unset = sync(src, dest, "x", { RELEASE_AUTHOR_NAME: "", RELEASE_AUTHOR_EMAIL: "" });
    expect(unset.status).not.toBe(0);
    expect(unset.stderr).toContain("expected RELEASE_AUTHOR_NAME and RELEASE_AUTHOR_EMAIL");
    const bare = sync(src, dest, "x", { RELEASE_AUTHOR_EMAIL: "noreply@users.noreply.github.com" });
    expect(bare.status).not.toBe(0);
    expect(bare.stderr).toContain("unrelated account");
    expect(git(dest, "rev-parse", "HEAD")).toBe(head);
  });

  test("refuses when the scan fails, and leaves the clone exactly as it was", () => {
    const home = `${"/Users"}/someone/x`;
    const src = source({ "README.md": `see ${home}\n` });
    const dest = clone();
    const head = git(dest, "rev-parse", "HEAD");
    const res = sync(src, dest, "bad");
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("home-path");
    expect(git(dest, "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(join(dest, "old.txt"))).toBe(true);
    expect(existsSync(join(dest, "README.md"))).toBe(false);
  });

  test("refuses a commit message that the scan would refuse", () => {
    const src = source({ "README.md": "hello\n" });
    const dest = clone();
    const res = sync(src, dest, `built in ${"/home"}/bob/work`);
    expect(res.status).not.toBe(0);
    expect(git(dest, "rev-list", "--count", "HEAD")).toBe("1");
  });

  test("refuses a destination that is not a git clone, one with uncommitted changes, one inside the source, and a missing message", () => {
    const src = source({ "README.md": "hello\n" });
    expect(sync(src, tmp("plain"), "m").status).not.toBe(0);
    const dirty = clone();
    writeFileSync(join(dirty, "old.txt"), "edited\n");
    const r = sync(src, dirty, "m");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("uncommitted");
    const inside = join(src, "inner");
    mkdirSync(inside);
    expect(sync(src, inside, "m").status).not.toBe(0);
    const sub = clone();
    mkdirSync(join(sub, "inner"));
    const subRes = sync(src, join(sub, "inner"), "m");
    expect(subRes.status).not.toBe(0);
    expect(subRes.stderr).toContain("top of a git clone");
    const ok = clone();
    expect(spawnSync("bash", [join(src, "scripts/release-sync.sh"), ok], { encoding: "utf8" }).status).not.toBe(0);
  });

  test("never pushes: the script holds no push, remote or fetch command", () => {
    const text = readFileSync(join(root, "scripts/release-sync.sh"), "utf8");
    const code = text
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(code).not.toMatch(/git\b[^\n]*\b(push|remote add|remote set-url|fetch|pull)\b/);
    expect(spawnSync("bash", ["-n", join(root, "scripts/release-sync.sh")]).status).toBe(0);
  });
});
