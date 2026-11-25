// Turns an existing menu (photos, text, Markdown or HTML) into catalog.json, with a list of what a person should check:
//   npm run import-menu -- page-1.jpg page-2.jpg --out config/catalog.json [--currency INR] [--report review.md] [--force]
// The model reads the menu (src/ai/menu-reader.ts); code builds and checks the catalog (src/import). It uses the AI
// analyst's settings (AI_BASE_URL, AI_MODEL, AI_API_KEY) from .env or the shell, and is off without them (D-092).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openModel } from "../src/ai/index.ts";
import { readMenuPiece } from "../src/ai/menu-reader.ts";
import { AiError } from "../src/ai/model.ts";
import { ConfigError } from "../src/core/config.ts";
import { isCurrency } from "../src/core/money.ts";
import { buildCatalog, EmptyMenuError, parseReply, type Reading, type ReviewItem } from "../src/import/catalog.ts";
import { ImportError, readInputs } from "../src/import/inputs.ts";

export interface Io {
  out(s: string): void;
  err(s: string): void;
}

const USAGE =
  "usage: npm run import-menu -- <menu files...> --out <config-folder>/catalog.json [--currency INR] [--report review.md] [--force]\n";

/** A menu photo takes a model far longer than a chat answer; used unless AI_TIMEOUT_SECONDS says otherwise. */
const IMPORT_TIMEOUT_MS = 120_000;

class Usage extends Error {}

interface Args {
  inputs: string[];
  out: string;
  currency: string;
  report?: string;
}

function parseArgs(argv: readonly string[]): Args | "help" {
  const inputs: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--help" || a === "-h") return "help";
    if (a === "--force") flags.force = true;
    else if (a === "--out" || a === "--currency" || a === "--report") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Usage(`expected a value after ${a}, found none`);
      flags[a.slice(2)] = v;
    } else if (a.startsWith("-")) {
      throw new Usage(`unknown option ${a}; expected --out, --currency, --report or --force`);
    } else inputs.push(a);
  }
  if (inputs.length === 0) {
    throw new Usage(
      "expected at least one menu file (a png, jpg or webp photo, or a txt, md or html file), found none",
    );
  }
  const out = flags.out;
  if (typeof out !== "string") throw new Usage("expected --out <config-folder>/catalog.json, found no --out");
  if (existsSync(out) && flags.force !== true) {
    throw new Usage(`${out}: expected a new file, found one that already exists; pass --force to replace it`);
  }
  let currency = typeof flags.currency === "string" ? flags.currency.toUpperCase() : undefined;
  if (currency !== undefined && !isCurrency(currency)) {
    throw new Usage(
      `expected --currency to be an ISO 4217 code such as INR, USD or KWD, found ${JSON.stringify(flags.currency)}`,
    );
  }
  currency ??= businessCurrency(join(dirname(out), "business.json"));
  if (currency === undefined) {
    throw new Usage(
      "expected --currency (such as INR or USD), or a business.json beside the --out file that names one; found neither",
    );
  }
  return { inputs, out, currency, ...(typeof flags.report === "string" ? { report: flags.report } : {}) };
}

/** The currency of the business.json beside the catalog, if there is a readable one. */
function businessCurrency(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const c = (JSON.parse(readFileSync(path, "utf8")) as { currency?: unknown }).currency;
    return typeof c === "string" && isCurrency(c) ? c : undefined;
  } catch {
    return undefined;
  }
}

/** Categories that no station in the folder's stations.json prepares: the business can't start until they have one. */
function stationGaps(path: string, categories: readonly { id: string; name: string }[]): ReviewItem[] {
  if (!existsSync(path)) return [];
  let listed: Set<string>;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { categories?: unknown }[];
    listed = new Set(raw.flatMap((s) => (Array.isArray(s.categories) ? s.categories.map(String) : [])));
  } catch {
    return [
      {
        file: "stations.json",
        kind: "no station",
        detail: "stations.json does not parse, so no category has a station",
      },
    ];
  }
  return categories
    .filter((c) => !listed.has(c.id))
    .map((c) => ({
      file: "stations.json",
      kind: "no station" as const,
      item: c.id,
      detail: `category "${c.id}" (${c.name}) has no station; add it to one before starting`,
    }));
}

function reviewLines(review: readonly ReviewItem[]): string {
  return review
    .map((r) => {
      const what = r.item === undefined ? "" : `${r.item}${r.section === undefined ? "" : ` (${r.section})`}: `;
      return `- ${r.file}: ${r.kind}: ${what}${r.detail}\n`;
    })
    .join("");
}

/** The whole command: 0 when catalog.json was written (whatever the review holds), 1 on a hard failure. */
export async function importMenuCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: Io,
) {
  try {
    const args = parseArgs(argv);
    if (args === "help") {
      io.out(USAGE);
      return 0;
    }
    let model: ReturnType<typeof openModel>;
    try {
      model = openModel(env);
    } catch (e) {
      throw new Usage((e as Error).message.replace(/^ibow: /, ""));
    }
    if (model === undefined) {
      throw new Usage(
        "expected AI_BASE_URL and AI_MODEL (the AI analyst's settings, plus AI_API_KEY if the provider needs one), found neither; set them in .env or the shell, with a model that reads images for photos",
      );
    }
    const timeoutMs = env.AI_TIMEOUT_SECONDS?.trim() ? undefined : IMPORT_TIMEOUT_MS;
    const parts = readInputs(args.inputs);
    const readings: Reading[] = [];
    const unread: ReviewItem[] = [];
    for (const part of parts) {
      io.out(`Reading ${part.file} (${part.label})\n`);
      let reply: string;
      try {
        reply = await readMenuPiece(model, part, timeoutMs);
      } catch (e) {
        if (!(e instanceof AiError)) throw e;
        throw new Usage(`${part.file} (${part.label}): ${e.message}; nothing was written`);
      }
      const parsed = parseReply(reply);
      if (parsed.ok) readings.push({ file: part.file, reply: parsed.menu });
      else {
        unread.push({
          file: part.file,
          kind: "unread part",
          detail: `${part.label}: the model's reply was not menu JSON (${parsed.reason}); skipped, so read it by hand or run it again`,
        });
      }
    }
    const { catalog, review } = buildCatalog(readings, args.currency, unread);
    review.push(...stationGaps(join(dirname(args.out), "stations.json"), catalog.categories));
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, `${JSON.stringify(catalog, null, 2)}\n`);
    const items = catalog.categories.reduce((n, c) => n + c.items.length, 0);
    const calls = `${parts.length} model ${parts.length === 1 ? "call" : "calls"}`;
    const where = args.report === undefined ? (review.length > 0 ? " (listed above)" : "") : ` (in ${args.report})`;
    const summary = `Wrote ${args.out}: ${catalog.categories.length} sections, ${items} items, ${catalog.extras?.length ?? 0} add-on groups, in ${args.currency}, from ${args.inputs.length} files in ${calls}; ${review.length} to check${where}.\n`;
    if (args.report !== undefined) {
      writeFileSync(args.report, `# Menu import: what to check\n\n${summary}\n${reviewLines(review) || "Nothing.\n"}`);
    } else if (review.length > 0) io.err(`What to check:\n${reviewLines(review)}`);
    io.out(summary);
    return 0;
  } catch (e) {
    if (e instanceof EmptyMenuError) io.err(reviewLines(e.review));
    if (e instanceof Usage)
      io.err(`import-menu: ${e.message}\n${e.message.startsWith("expected at least one menu") ? USAGE : ""}`);
    else if (e instanceof ImportError) io.err(`${e.message}\n`);
    else if (e instanceof ConfigError) {
      io.err(`import-menu: the catalog it built does not load, a bug in import-menu: ${e.message}\n`);
    } else throw e;
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await importMenuCli(process.argv.slice(2), process.env, {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  });
}
