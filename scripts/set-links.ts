// Fills in the link placeholders (LINKEDIN, INSTAGRAM, DEMO, SHOWCASE and REPO, each written in double braces with a
// _URL suffix) in the README, the showcase page, SECURITY.md and anywhere else they stand, before the first release:
//   npm run set-links -- --linkedin https://www.linkedin.com/in/you --instagram https://www.instagram.com/you \
//     --demo https://ibow-demo.you.workers.dev --repo https://github.com/you/ibow
// The showcase address is the demo's plus /showcase. Every address must be https; LinkedIn, Instagram and the repo must
// be on their own sites. Nothing is written unless every address given is valid. scripts/release-scan.ts fails an
// export that still holds a placeholder.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** The placeholder names, built here so this file itself holds none for the release scan to find. */
export const PLACEHOLDER_NAMES = ["LINKEDIN", "INSTAGRAM", "DEMO", "SHOWCASE", "REPO"] as const;
export type PlaceholderName = (typeof PLACEHOLDER_NAMES)[number];
export const placeholder = (name: PlaceholderName): string => `{{${name}_URL}}`;

export type Links = Partial<Record<"linkedin" | "instagram" | "demo" | "repo", string>>;

/** The sites an address must be on (the site itself or any subdomain, such as www or in); the demo may be anywhere. */
const HOSTS: Record<"linkedin" | "instagram" | "repo", string> = {
  linkedin: "linkedin.com",
  instagram: "instagram.com",
  repo: "github.com",
};
const FORBIDDEN = /[\s"'<>(){}\\`]/;

/** An address checked and normalised, or an Error saying what was expected and what was found. */
export function checkLink(kind: keyof Links, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`set-links: expected --${kind} to be an https address, found ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`set-links: expected --${kind} to start with https://, found ${JSON.stringify(raw)}`);
  }
  if (url.username !== "" || url.password !== "" || FORBIDDEN.test(raw)) {
    throw new Error(
      `set-links: expected --${kind} without credentials, spaces, quotes, brackets or braces, found ${JSON.stringify(raw)}`,
    );
  }
  if (kind !== "demo") {
    const site = HOSTS[kind];
    const host = url.hostname.toLowerCase();
    if (host !== site && !host.endsWith(`.${site}`)) {
      throw new Error(`set-links: expected --${kind} on ${site}, found the host ${JSON.stringify(url.hostname)}`);
    }
  }
  if (kind === "demo" && (url.search !== "" || url.hash !== "" || /[?#]/.test(raw))) {
    throw new Error(`set-links: expected --demo without a query or fragment, found ${JSON.stringify(raw)}`);
  }
  if (kind === "repo" && url.pathname.split("/").filter(Boolean).length < 2) {
    throw new Error(`set-links: expected --repo as https://github.com/<owner>/<repo>, found ${JSON.stringify(raw)}`);
  }
  return kind === "demo" ? url.href.replace(/\/+$/, "") : url.href;
}

/** The placeholder-to-address pairs for the addresses given; SHOWCASE follows the demo. Throws on the first bad one. */
export function replacements(links: Links): Map<string, string> {
  const out = new Map<string, string>();
  const set = (name: PlaceholderName, value: string) => out.set(placeholder(name), value);
  if (links.linkedin !== undefined) set("LINKEDIN", checkLink("linkedin", links.linkedin));
  if (links.instagram !== undefined) set("INSTAGRAM", checkLink("instagram", links.instagram));
  if (links.repo !== undefined) set("REPO", checkLink("repo", links.repo));
  if (links.demo !== undefined) {
    const demo = checkLink("demo", links.demo);
    set("DEMO", demo);
    set("SHOWCASE", `${demo}/showcase`);
  }
  return out;
}

const SKIP = new Set([".git", "node_modules", "dist", ".wrangler", "runs", "data"]);

function walk(root: string, dir = root): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (SKIP.has(e.name)) return [];
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(root, p) : [p];
  });
}

/** Replaces the placeholders in every text file under `dir`; returns the files changed (relative, forward slashes). */
export function applyLinks(dir: string, links: Links): string[] {
  const pairs = replacements(links);
  const changed: string[] = [];
  for (const path of walk(dir)) {
    const body = readFileSync(path);
    if (body.includes(0)) continue;
    let text = body.toString("utf8");
    const before = text;
    for (const [from, to] of pairs) text = text.split(from).join(to);
    if (text === before) continue;
    writeFileSync(path, text);
    changed.push(relative(dir, path).split("\\").join("/"));
  }
  return changed.sort();
}

/** The four options of the command line. */
export function parseArgs(argv: readonly string[]): Links {
  const links: Links = {};
  const known = ["linkedin", "instagram", "demo", "repo"] as const;
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] ?? "";
    const kind = known.find((k) => flag === `--${k}`);
    const value = argv[i + 1];
    if (kind === undefined || value === undefined || value.startsWith("--")) {
      throw new Error(
        `set-links: expected --linkedin, --instagram, --demo or --repo, each followed by an https address, found ${JSON.stringify(
          argv.slice(i, i + 2).join(" "),
        )}`,
      );
    }
    links[kind] = value;
  }
  if (Object.keys(links).length === 0) {
    throw new Error("set-links: expected at least one of --linkedin, --instagram, --demo, --repo, found none");
  }
  return links;
}

if (import.meta.main) {
  try {
    const root = fileURLToPath(new URL("../", import.meta.url));
    if (!existsSync(join(root, "package.json"))) throw new Error(`set-links: expected the repo at ${root}`);
    const changed = applyLinks(root, parseArgs(process.argv.slice(2)));
    console.log(`set-links: ${changed.length} files changed${changed.length ? `: ${changed.join(", ")}` : ""}`);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  }
}
