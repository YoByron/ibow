/**
 * M6 release check: the scan run on a release export before it is published. Secrets in these fixtures are built at
 * run time, so the repo itself never holds anything the scan would find.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { BLOCKED_TERMS, pruneExport, scanTree, termEntry, termHash } from "../scripts/release-scan.ts";
import { applyLinks, placeholder } from "../scripts/set-links.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tree(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), "ibow-scan-test-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

// A made-up name standing in for a real business's, hashed as the real ones are.
const fake = [termEntry("zorblaxchai"), termEntry("zorblax")];
const rules = (dir: string, terms = fake) => scanTree(dir, { terms }).map((f) => `${f.file}:${f.line}:${f.rule}`);

describe("blocked names", () => {
  test("finds a hashed name as a word, joined, split by spaces, dashes or dots, in any case or accent", () => {
    const dir = tree({
      "a.md": "Run live at Zorblax Chai since 2025.\n",
      "b.json": '{"name": "ZORBLAX-chai Special"}\n',
      "c.ts": "const host = 'cg.zorblax.in';\n",
      "d.txt": "ZórbláxChai\n",
      "ok.md": "Zorbla and blaxchai are other words.\n",
    });
    expect(rules(dir)).toEqual(["a.md:1:name", "b.json:1:name", "c.ts:1:name", "d.txt:1:name"]);
  });

  test("the names of the real business and brands are kept only as hashes", () => {
    expect(BLOCKED_TERMS.length).toBeGreaterThanOrEqual(5);
    expect(BLOCKED_TERMS.every((h) => /^\d+:[0-9a-f]{32}$/.test(h))).toBe(true);
    expect(termHash("Zorblax")).toBe(termHash("zorblax"));
    expect(termEntry("Zor-blax")).toBe(`7:${termHash("zorblax")}`);
  });

  test("finds a name of 5 or more letters inside a longer word, letter-spaced, or in look-alike letters", () => {
    // Cyrillic o, a and x in the middle of a Latin word, and a Greek omicron.
    const lookAlike = "Zоrblах is open, and so is ZORBLΟX";
    const dir = tree({
      "a.md": "The Zorblaxwala stall.\n",
      "b.md": "Ask for z o r b l a x at the counter.\n",
      "c.md": "Z.O.R.B.L.A.X\n",
      "d.md": `${lookAlike}\n`,
      "e.md": "Zorbla and blax and z o r b l a are other words.\n",
    });
    expect(rules(dir)).toEqual(["a.md:1:name", "b.md:1:name", "c.md:1:name", "d.md:1:name"]);
  });
});

describe("secrets", () => {
  test("finds keys, PIN hashes, real-looking UPI IDs, env files, databases and key files", () => {
    const dir = tree({
      "keys.ts": [
        `const a = "${"sk-"}${"A1b2".repeat(8)}";`,
        `const b = "${"AKIA"}${"ABCDEFGHIJKLMNOP"}";`,
        `const c = "${"ghp_"}${"x".repeat(36)}";`,
        `${"-----BEGIN "}RSA PRIVATE KEY-----`,
        `OWNER_PIN_HASH=${"scrypt$"}16384$8$1$${"s".repeat(22)}$${"k".repeat(43)}`,
        `UPI_VPA=${"shopowner"}@${"oksbi"}`,
      ].join("\n"),
      ".env": "PORT=3000\n",
      ".dev.vars": "OWNER_PIN_HASH=x\n",
      "config/.env.production": "X=1\n",
      "data/ibow.db": Buffer.from("SQLite format 3\0"),
      "certs/site.pem": "x\n",
    });
    expect(rules(dir)).toEqual([
      ".dev.vars:0:env-file",
      ".env:0:env-file",
      "certs/site.pem:0:key-file",
      "config/.env.production:0:env-file",
      "data/ibow.db:0:database",
      "keys.ts:1:api-key",
      "keys.ts:2:api-key",
      "keys.ts:3:api-key",
      "keys.ts:4:private-key",
      "keys.ts:5:pin-hash",
      "keys.ts:6:upi-id",
    ]);
  });

  test("passes placeholders: the example handle, your… and name@, emails, package names and .env.example", () => {
    const dir = tree({
      ".env.example": "UPI_VPA=\n# Example: yourbusiness@upi\nOWNER_PIN_HASH=\n",
      ".dev.vars.example": "OWNER_PIN_HASH=\n",
      "a.ts": 'const vpa = "teahouse@example"; // a UPI ID like name@bank\n',
      "b.md": "Mail dev@example.org, see @hono/node-server and uqr@0.1.3; yourname@bank.\n",
      "c.ts": 'const re = /^scrypt\\$/; const p = "-----BEGIN " + kind;\n',
      "img.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]),
    });
    expect(rules(dir)).toEqual([]);
  });
});

test("this repo's own tracked files pass the scan with the real blocked terms", () => {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const findings = scanTree(root, { files });
  expect(findings).toEqual([]);
}, 120_000);

describe("export check", () => {
  // A made-up assistant name standing in for the real ones, hashed the same way.
  const assistant = [termHash("quillbot9")];
  const exportRules = (dir: string) =>
    scanTree(dir, { terms: fake, export: true, exportTerms: assistant }).map((f) => `${f.file}:${f.line}:${f.rule}`);

  test("finds assistant names and absolute home paths, which the plain scan leaves alone", () => {
    const dir = tree({
      "a.md": "Written with QuillBot 9 help.\n",
      "b.md": `See ${"C:"}Users\bobcode and ${"/home"}/bob/x and ${"/Users"}/bob/y.\n`,
      "c.md": "Plain words, /var/lib/ibow and --home /var/lib/ibow.\n",
    });
    expect(exportRules(dir)).toEqual(["a.md:1:export-term", "b.md:1:home-path"]);
    expect(rules(dir)).toEqual([]);
  });

  test("the real export terms refuse model-tier names as whole words, and let ordinary words containing them through", () => {
    // Written backwards, so this file does not hold the names it tests for.
    const names = ["tennos", "supo", "ukiah", "elbaf"].map((r) => [...r].reverse().join(""));
    const dir = tree(Object.fromEntries(names.map((n, i) => [`n${i}.md`, `Built by the ${n} crew.\n`])));
    expect(scanTree(dir, { terms: fake, export: true }).map((f) => f.file)).toEqual(names.map((_, i) => `n${i}.md`));
    const fine = tree({ "a.md": "An affable fabled tale, a few haikus and sonnets.\n" });
    expect(scanTree(fine, { terms: fake, export: true })).toEqual([]);
  });

  test("model providers and API names are not attribution: the real export terms let them through (D-029)", () => {
    const dir = tree({
      "a.md": "Any OpenAI-compatible Chat Completions API: OpenAI, Gemini's compatible endpoint, OpenRouter, Groq.\n",
      "openai-notes.md": "gemini, openai\n",
    });
    expect(scanTree(dir, { export: true, commit: false })).toEqual([]);
  });

  test("checks the export's commit message and names", () => {
    const dir = tree({ "a.md": "hello\n" });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    git("init", "-q");
    git("add", "-A");
    git("-c", "user.name=A", "-c", "user.email=a@example.org", "commit", "-qm", "first\n\nHelped-by: QuillBot9");
    expect(exportRules(dir)).toEqual(["(commit):0:export-term"]);
  });

  test("pruneExport removes files and folders named after an export term and ignore-file lines naming them", () => {
    const dir = tree({
      "QUILLBOT9.md": "notes\n",
      ".quillbot9/agents/a.md": "agent\n",
      "src/app.ts": "ok\n",
      ".gitignore": "data/\n.quillbot9\nQUILLBOT9.md\nnode_modules\n",
    });
    const removed = pruneExport(dir, assistant);
    expect(removed.sort()).toEqual([".gitignore:2", ".gitignore:3", ".quillbot9", "QUILLBOT9.md"]);
    expect(existsSync(join(dir, "QUILLBOT9.md"))).toBe(false);
    expect(existsSync(join(dir, ".quillbot9"))).toBe(false);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("data/\nnode_modules\n");
    expect(exportRules(dir)).toEqual([]);
  });

  test("an ignore-file line naming an export term fails the export check: there is no allowance", () => {
    const dir = tree({ ".gitignore": "QUILLBOT9.md\n", ".gitattributes": "QUILLBOT9.md export-ignore\n" });
    expect(exportRules(dir)).toEqual([".gitattributes:1:export-term", ".gitignore:1:export-term"]);
  });

  test("this repo's tracked files, pruned as the export is, pass the export check", () => {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
    const out = tree({});
    for (const f of files) {
      mkdirSync(dirname(join(out, f)), { recursive: true });
      writeFileSync(join(out, f), readFileSync(join(root, f)));
    }
    const removed = pruneExport(out);
    // The assistant's folder, found by its agents/ subfolder so this file doesn't name it.
    const devDir = files.find((f) => /^\.[^/]+\/agents\//.test(f))?.split("/")[0] as string;
    expect(removed).toContain(devDir);
    expect(removed).toContain(`${devDir.slice(1).toUpperCase()}.md`);
    // Link placeholders are the only thing a pruned tree may still hold (none once set-links has run).
    const rulesLeft = scanTree(out, { export: true, commit: false }).map((f) => f.rule);
    expect(rulesLeft.filter((r) => r !== "link-placeholder")).toEqual([]);
    applyLinks(out, {
      linkedin: "https://www.linkedin.com/in/someone",
      instagram: "https://www.instagram.com/someone",
      demo: "https://demo.example.org",
      repo: "https://github.com/someone/ibow",
    });
    expect(scanTree(out, { export: true, commit: false })).toEqual([]);
  }, 120_000);

  test("fails the export on any link placeholder left in a file, and not the plain scan", () => {
    const dir = tree({
      "README.md": `Find me: ${placeholder("LINKEDIN")}\n`,
      "page.html": `<a href="${placeholder("DEMO")}">demo</a> ${placeholder("SHOWCASE")} ${placeholder("REPO")}\n`,
      "ok.md": "Double braces {{like this}} and a {{LOWER_url}} are not placeholders.\n",
    });
    expect(exportRules(dir)).toEqual(["README.md:1:link-placeholder", "page.html:1:link-placeholder"]);
    expect(rules(dir)).toEqual([]);
  });
});

describe("more secrets", () => {
  test("finds any *.env file and password or secret settings with real values", () => {
    const dir = tree({
      "deploy/prod.env": "PORT=3000\n",
      // Built from parts, so this file holds no setting the scan would find.
      "a.sh": [
        ["DB_PASSWORD", "hunter2go"],
        ["password", "s3cret!"],
        ["export API_SECRET", '"abc123xyz"'],
        ["SMTP_PASSWORD", ""],
        ["ADMIN_PASSWORD", "<your password>"],
        ["APP_SECRET", "$" + "{APP_SECRET}"],
        ["OWNER_PASSWORD", "changeme"],
      ]
        .map((kv) => kv.join("="))
        .join("\n"),
      ".env.example": ["DB_PASSWORD", "\n"].join("="),
    });
    expect(rules(dir)).toEqual(["a.sh:1:password", "a.sh:2:password", "a.sh:3:password", "deploy/prod.env:0:env-file"]);
  });
});
