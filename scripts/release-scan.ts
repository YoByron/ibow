// Scans a release export before it is published: node scripts/release-scan.ts [--export] <dir>
// Prepares one first: node scripts/release-scan.ts --prune <dir> (see pruneExport).
// Fails (exit 1) on the real business's name or a brand, a key, a PIN hash, a real-looking UPI ID, an env file, a
// database or a key file, printing file, line and rule but never the matched text. With --export (as
// scripts/release-export.sh runs it) it also fails on assistant and vendor names, the hub's names, absolute home
// paths and unfilled link placeholders (see scripts/set-links.ts), in the files and in the export's commit.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

/**
 * The real business's name, its app's and host's names, and third-party brands once in its menu, removed in M0. Kept
 * only as `length:hash` entries (`termEntry`) so this file doesn't put them back in the tree; a new term is added the
 * same way. The length lets a term of 5 or more letters be found inside a longer word.
 */
export const BLOCKED_TERMS: readonly string[] = [
  "9:88756342653d77cf5537902acd31befd",
  "5:e4c8ea24e9b291ae32c630064c1e5fb5",
  "15:be389735d97b9e6776bf90891049d25a",
  "9:7a9ea32fd11b64f8ec963297a3ddf7cb",
  "6:83ea28b77ece08a765310df7c0311bac",
  "6:6042083e41ada5e3d2027a45a8e27498",
  "5:04e7e94db93ef541ba11e483e81afdf5",
  "6:19b58a7192364c6ace519ba8d6f67825",
  "3:1bcae08b9e07fa27a4bcc712d6bd6829",
];

/** Terms this long or longer are also looked for inside longer words (a name plus a suffix). */
const SUBSTRING_MIN = 5;

/**
 * Export only: names of coding assistants and their maker, an attribution trailer, and the private hub this project
 * was started from (its repo's name and its home folder's), hashed like the names above. These may appear in
 * development files, which `pruneExport` takes out of an export by their names, never in what ships. Model providers
 * and API names are not attribution and are not listed: the docs name them as places the AI analyst can connect to
 * (D-029).
 */
export const EXPORT_TERMS: readonly string[] = [
  "1918bb65b43a9230be41605ab63683c0",
  "e835bb9d662221c108e280f661b85548",
  "4a8dcd5efe22da443f5cbaf98a254e67",
  "dcee48f71dc0714aa18e2423bb365f23",
  "4cceda89df65da4314904c1f8b3203c7",
  "e11c79cadb0d4026cfd9fb9c0e6df460",
  "95aabb0a063fcdebd5a764a6d1b3a288",
  "fb282614baa6fcd1bd3a2e4a9f888434",
  // Model-tier names, as whole words only, so longer words that contain one are fine.
  "7e894ac3de2d40d3c7b4b5c130f1b6d3",
  "b20a2cc0a1512cba985840fb7e3ac3cd",
  "3cbc04dab0119d0efe326c3142750c85",
  "a31e8a4e06da776dc5952247f13a0ae9",
];

/** A link placeholder (`npm run set-links` fills them in); one left in an export is a link that would ship broken. */
const LINK_PLACEHOLDER = /\{\{[A-Z][A-Z0-9_]*_URL\}\}/;

/** An absolute path into someone's home folder: a machine's details leaking into docs or code. */
const HOME_PATH = /[A-Za-z]:[\\/]+Users[\\/]|\/home\/[\w.-]+|\/Users\/[\w.-]+/;

/** A term as the scan compares it: accents dropped, letters and digits only, lower case, then hashed. */
export function termHash(term: string): string {
  return createHash("sha256")
    .update(`ibow-release-scan/${normalise(term)}`)
    .digest("hex")
    .slice(0, 32);
}

/** A blocked-term entry, `length:hash`, of a term's normalised form. */
export function termEntry(term: string): string {
  return `${normalise(term).length}:${termHash(term)}`;
}

/** Cyrillic and Greek letters that look like Latin ones, folded so a look-alike spelling still matches. */
const LOOK_ALIKES: Readonly<Record<string, string>> = {
  А: "a",
  а: "a",
  В: "b",
  в: "b",
  Е: "e",
  е: "e",
  К: "k",
  к: "k",
  М: "m",
  м: "m",
  Н: "h",
  н: "h",
  О: "o",
  о: "o",
  Р: "p",
  р: "p",
  С: "c",
  с: "c",
  Т: "t",
  т: "t",
  Х: "x",
  х: "x",
  У: "y",
  у: "y",
  І: "i",
  і: "i",
  Ј: "j",
  ј: "j",
  Ѕ: "s",
  ѕ: "s",
  Ԁ: "d",
  ԁ: "d",
  Α: "a",
  α: "a",
  Β: "b",
  β: "b",
  Ε: "e",
  ε: "e",
  Ζ: "z",
  Η: "h",
  η: "n",
  Ι: "i",
  ι: "i",
  Κ: "k",
  κ: "k",
  Μ: "m",
  Ν: "n",
  ν: "v",
  Ο: "o",
  ο: "o",
  Ρ: "p",
  ρ: "p",
  Τ: "t",
  τ: "t",
  Υ: "y",
  υ: "u",
  Χ: "x",
  χ: "x",
};

function fold(s: string): string {
  return s.replace(/[Ͱ-ϿЀ-ӿԀ-ԯ]/g, (c) => LOOK_ALIKES[c] ?? c);
}

function normalise(s: string): string {
  return fold(s)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

export interface Finding {
  file: string;
  /** 0 for a finding about the file itself. */
  line: number;
  rule: string;
}

const LINE_RULES: readonly { rule: string; re: RegExp }[] = [
  { rule: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    rule: "api-key",
    re: /\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20})/,
  },
  { rule: "pin-hash", re: /(?:scrypt\$\d+\$\d+\$\d+|pbkdf2-sha256\$\d+)\$[A-Za-z0-9_-]{8,}\$[A-Za-z0-9_-]{16,}/ },
];
/** A UPI ID such as name@bank, with no dot after it (an email's domain has one). */
const UPI_ID = /(?<![\w.@/-])([A-Za-z0-9._-]{2,256})@([A-Za-z][A-Za-z0-9]{1,63})(?![\w.@])/g;

/** Example handles the docs and tests use: the `example` handle, `your…@`, and `name@` as in "name@bank". */
function isPlaceholderUpi(local: string, handle: string): boolean {
  const l = local.toLowerCase();
  return handle.toLowerCase() === "example" || l.startsWith("your") || l === "name";
}

/** A password or secret setting (lower-case password, or a NAME ending in _PASSWORD or _SECRET) and its value. */
const PASSWORD = /(?:^|[^\w])((?:\w+_)?PASSWORD|password|\w+_SECRET)=["']?([^"'\s#]*)/;
/** An empty value, a \${VAR} reference, a <placeholder>, or an obvious stand-in is not a secret. */
function isPlaceholderValue(v: string): boolean {
  return (
    v === "" ||
    /^\$\{?\w+\}?$/.test(v) ||
    /^<.*>?$/.test(v) ||
    /^(changeme|example|placeholder|x+|\*+|\.\.\.)$/i.test(v)
  );
}

function fileRule(path: string): string | undefined {
  const name = basename(path).toLowerCase();
  // .dev.vars is wrangler's local secrets file, the Workers counterpart of .env.
  const envFile =
    name === ".env" ||
    name.startsWith(".env.") ||
    name.endsWith(".env") ||
    name === ".dev.vars" ||
    name.startsWith(".dev.vars.");
  if (envFile && name !== ".env.example" && name !== ".dev.vars.example") return "env-file";
  if (/\.(db|sqlite|sqlite3)(-wal|-shm|-journal)?$/.test(name)) return "database";
  if (/\.(pem|key|p12|pfx)$/.test(name) || /^id_(rsa|ed25519|ecdsa)$/.test(name)) return "key-file";
  return undefined;
}

/** Hashes of word runs already seen: data files repeat the same few words thousands of times. */
const seen = new Map<string, string>();
function cachedHash(joined: string): string {
  let h = seen.get(joined);
  if (h === undefined) {
    h = termHash(joined);
    seen.set(joined, h);
  }
  return h;
}

/** Terms to look for: hashes matched against whole words and runs, and the lengths also looked for inside words. */
interface TermSet {
  hashes: ReadonlySet<string>;
  /** Lengths of terms with 5 or more letters (only entries written `length:hash` carry one). */
  inner: readonly number[];
}

function termSet(entries: readonly string[]): TermSet {
  const hashes = new Set<string>();
  const inner = new Set<number>();
  for (const e of entries) {
    const [len, hash] = e.includes(":") ? e.split(":") : ["0", e];
    hashes.add(hash as string);
    if (Number(len) >= SUBSTRING_MIN) inner.add(Number(len));
  }
  return { hashes, inner: [...inner] };
}

/** Words of a line, with runs of 3 or more single letters ("z o r b") joined back into one word. */
function words(line: string): string[] {
  const raw = fold(line)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const out: string[] = [];
  let letters: string[] = [];
  const flush = () => {
    if (letters.length >= 3) out.push(letters.join(""));
    else out.push(...letters);
    letters = [];
  };
  for (const w of raw) {
    if (w.length === 1) letters.push(w);
    else {
      flush();
      out.push(w);
    }
  }
  flush();
  return out;
}

function nameHits(line: string, terms: TermSet): boolean {
  const ws = words(line);
  for (let i = 0; i < ws.length; i++) {
    let joined = "";
    for (let j = i; j < Math.min(i + 3, ws.length); j++) {
      joined += ws[j];
      if (terms.hashes.has(cachedHash(joined))) return true;
    }
    // Inside a longer word: a name with a suffix or prefix stuck to it.
    const w = ws[i] as string;
    for (const len of terms.inner) {
      for (let k = 0; k + len < w.length + 1 && len < w.length; k++) {
        if (terms.hashes.has(cachedHash(w.slice(k, k + len)))) return true;
      }
    }
  }
  return false;
}

function walk(root: string, dir = root): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === ".git") return [];
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(root, p) : [relative(root, p)];
  });
}

/**
 * Scans `dir` (every file but `.git`, or only `files`, relative to it). Binary files (any NUL byte) are checked by name
 * only. Findings are sorted by file, then line.
 */
export function scanTree(
  dir: string,
  opts: {
    terms?: readonly string[];
    files?: readonly string[];
    /** Also the export-only checks: assistant and hub names, home paths, and the commit (unless `commit` is false). */
    export?: boolean;
    exportTerms?: readonly string[];
    commit?: boolean;
  } = {},
): Finding[] {
  const terms = termSet(opts.terms ?? BLOCKED_TERMS);
  const exportTerms = termSet(opts.export ? (opts.exportTerms ?? EXPORT_TERMS) : []);
  const findings: Finding[] = [];
  const files = (opts.files ?? walk(dir).map((f) => f.split(sep).join("/"))).slice();
  for (const file of files) {
    const byName = fileRule(file);
    if (byName) findings.push({ file, line: 0, rule: byName });
    const body = readFileSync(join(dir, file));
    if (body.includes(0)) continue;
    const lines = body.toString("utf8").split("\n");
    lines.forEach((text, i) => {
      const line = i + 1;
      if (nameHits(text, terms)) findings.push({ file, line, rule: "name" });
      if (opts.export && nameHits(text, exportTerms)) findings.push({ file, line, rule: "export-term" });
      if (opts.export && HOME_PATH.test(text)) findings.push({ file, line, rule: "home-path" });
      if (opts.export && LINK_PLACEHOLDER.test(text)) findings.push({ file, line, rule: "link-placeholder" });
      for (const { rule, re } of LINE_RULES) if (re.test(text)) findings.push({ file, line, rule });
      const pw = PASSWORD.exec(text);
      if (pw && !isPlaceholderValue(pw[2] as string)) findings.push({ file, line, rule: "password" });
      for (const m of text.matchAll(UPI_ID)) {
        if (!isPlaceholderUpi(m[1] as string, m[2] as string)) {
          findings.push({ file, line, rule: "upi-id" });
          break;
        }
      }
    });
  }
  if (opts.export && opts.commit !== false && existsSync(join(dir, ".git"))) {
    const meta = execFileSync("git", ["log", "-1", "--format=%B%n%an%n%ae%n%cn%n%ce"], { cwd: dir, encoding: "utf8" });
    const all = termSet([...(opts.terms ?? BLOCKED_TERMS), ...(opts.exportTerms ?? EXPORT_TERMS)]);
    if (meta.split("\n").some((l) => nameHits(l, all)))
      findings.push({ file: "(commit)", line: 0, rule: "export-term" });
  }
  return findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
}

/**
 * Prepares an export for publishing: removes every file or folder whose name contains an export term (development
 * files such as an assistant's instructions, found by name so no list of them lives in the repo), and drops the lines
 * of \`.gitignore\` that name them. Returns what it removed: paths, and \`file:line\` for lines.
 */
export function pruneExport(dir: string, exportTerms: readonly string[] = EXPORT_TERMS): string[] {
  const terms = termSet(exportTerms);
  const removed: string[] = [];
  const visit = (rel: string) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (nameHits(e.name, terms)) {
        rmSync(join(dir, path), { recursive: true, force: true });
        removed.push(path);
      } else if (e.isDirectory()) visit(path);
    }
  };
  visit("");
  for (const file of [".gitignore"]) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    const kept: string[] = [];
    readFileSync(path, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (nameHits(line, terms)) removed.push(`${file}:${i + 1}`);
        else kept.push(line);
      });
    writeFileSync(path, kept.join("\n"));
  }
  return removed;
}

if (import.meta.main && process.argv[2] === "--prune") {
  const dir = process.argv[3];
  if (dir === undefined) {
    process.stderr.write("release-scan: expected a directory to prune after --prune, found nothing\n");
    process.exit(2);
  }
  const removed = pruneExport(dir);
  console.log(`release-scan: pruned ${removed.length} development entries from ${dir}`);
} else if (import.meta.main) {
  const args = process.argv.slice(2);
  const exportMode = args.includes("--export");
  const dir = args.find((a) => a !== "--export");
  if (dir === undefined) {
    process.stderr.write("release-scan: expected a directory to scan, found nothing\n");
    process.exit(2);
  }
  const findings = scanTree(dir, { export: exportMode });
  for (const f of findings) process.stderr.write(`release-scan: ${f.file}:${f.line}: ${f.rule}\n`);
  if (findings.length > 0) {
    process.stderr.write(`release-scan: expected nothing to block a release in ${dir}, found ${findings.length}\n`);
    process.exit(1);
  }
  const what = exportMode ? ", assistant and hub names, home paths, the commit" : "";
  console.log(
    `release-scan: ${dir} is clean (names, brands, keys, PIN hashes, UPI IDs, env, database and key files${what})`,
  );
}
