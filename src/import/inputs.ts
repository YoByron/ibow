/**
 * The menu importer's inputs (M15, D-092, D-093): each file becomes one or more parts for the model. Images go as
 * data URLs; text, Markdown and HTML are read in code (HTML loses its tags here, never in a model) and split under
 * a token budget. A PDF is refused with what to do instead.
 */

import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";

/** One model call's worth of menu: a picture or a piece of text, and the file it came from. */
export interface MenuPart {
  /** The input as the person typed it, for the report. */
  file: string;
  /** "part 2 of 3": what the model and the report are told. Never the path. */
  label: string;
  text?: string;
  /** A `data:image/...;base64,` URL. */
  image?: string;
}

/** A failure before or after the model, in the words of Principle 3. */
export class ImportError extends Error {
  constructor(where: string, expected: string, found: string) {
    super(`import-menu: ${where}: expected ${expected}, found ${found}`);
    this.name = "ImportError";
  }
}

/**
 * Text per model call, in characters (about 4 to a token, so about 2,000 tokens). A menu line becomes about three
 * times as many tokens of JSON, and the reply is capped at `MENU_MAX_TOKENS` (8,192) and 64 KB, so the input stays
 * well under a third of that.
 */
export const TEXT_BUDGET_CHARS = 8000;
/** The largest image sent; most providers refuse 20 MB and a phone photo of a page is 2 to 5 MB. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const IMAGES: Record<string, { mime: string; name: string; is: (b: Buffer) => boolean }> = {
  ".png": { mime: "image/png", name: "PNG", is: (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) },
  ".jpg": { mime: "image/jpeg", name: "JPEG", is: (b) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) },
  ".jpeg": { mime: "image/jpeg", name: "JPEG", is: (b) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) },
  ".webp": {
    mime: "image/webp",
    name: "WebP",
    is: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  },
};
const TEXTS = new Set([".txt", ".md", ".markdown"]);
const HTMLS = new Set([".html", ".htm"]);
const KNOWN = [...Object.keys(IMAGES), ...TEXTS, ...HTMLS].join(", ");

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  pound: "£",
  euro: "€",
  yen: "¥",
  cent: "¢",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  middot: "·",
  times: "×",
  frac12: "½",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  ccedil: "ç",
  ntilde: "ñ",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
};
const BLOCK =
  /<\/?(?:p|div|br|li|ul|ol|tr|table|tbody|thead|h[1-6]|section|article|header|footer|main|nav|aside|dt|dd|dl|hr|blockquote|figure|figcaption|pre)\b[^>]*>/gi;

/** Marks where a heading starts, so it opens a paragraph (where `splitText` may cut). Not whitespace, so it survives trims. */
const HEADING = String.fromCodePoint(0xe000);

/**
 * The readable text of an HTML page, one line per block, a blank line before each heading, entities decoded. Pure
 * code: no model sees the markup.
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replaceAll(HEADING, "")
    .replace(/<h[1-6]\b[^>]*>/gi, `\n${HEADING}`)
    .replace(BLOCK, "\n")
    .replace(/<\/t[dh]\s*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, name: string) => {
      if (name[0] === "#") {
        const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    });
  return tidy(text)
    .split("\n")
    .filter((l) => l !== "")
    .join("\n")
    .replace(new RegExp(`\\n?${HEADING}`, "g"), "\n\n")
    .trim();
}

/** Lines trimmed, runs of spaces as one, blank runs kept as one blank line (a section break). */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * `text` in pieces of at most `max` characters, in order: whole paragraphs (blank-line separated) where they fit,
 * else whole lines, else hard cuts. A section heading and its items stay together when they fit in one piece.
 */
export function splitText(text: string, max: number): string[] {
  const pieces: string[] = [];
  let current = "";
  const push = (unit: string, sep: string) => {
    if (current === "") current = unit;
    else if (current.length + sep.length + unit.length <= max) current += sep + unit;
    else {
      pieces.push(current);
      current = unit;
    }
  };
  for (const para of tidy(text).split("\n\n")) {
    if (para.length <= max) {
      push(para, "\n\n");
      continue;
    }
    for (const line of para.split("\n")) {
      for (let i = 0; i < line.length; i += max) push(line.slice(i, i + max), i === 0 ? "\n" : "");
    }
  }
  if (current !== "") pieces.push(current);
  return pieces;
}

/** Every input as parts, in the order given, or an `ImportError` before any model call. */
export function readInputs(paths: readonly string[], budget = TEXT_BUDGET_CHARS): MenuPart[] {
  const parts: MenuPart[] = [];
  for (const path of paths) {
    const ext = extname(path).toLowerCase();
    const name = basename(path);
    if (ext === ".pdf") {
      throw new ImportError(
        path,
        "a photo, text, Markdown or HTML file (a PDF is not read)",
        "a PDF; export its pages as PNG or JPG images (or save its text as a .txt file) and pass those instead",
      );
    }
    const image = IMAGES[ext];
    if (image === undefined && !TEXTS.has(ext) && !HTMLS.has(ext)) {
      throw new ImportError(path, `a menu file ending in ${KNOWN}`, ext === "" ? "no extension" : ext);
    }
    let bytes: Buffer;
    try {
      if (!statSync(path).isFile()) throw new ImportError(path, "a file", "a folder");
      bytes = readFileSync(path);
    } catch (e) {
      if (e instanceof ImportError) throw e;
      throw new ImportError(path, "a readable file", "no such file (or no permission to read it)");
    }
    if (image !== undefined) {
      if (!image.is(bytes)) throw new ImportError(path, `a ${image.name} image`, "a file whose bytes are not one");
      if (bytes.length > MAX_IMAGE_BYTES) {
        throw new ImportError(
          path,
          `an image of at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB`,
          `${(bytes.length / 1024 / 1024).toFixed(1)} MB; save it smaller (a page is readable at 2000 pixels across)`,
        );
      }
      parts.push({ file: name, label: "one page", image: `data:${image.mime};base64,${bytes.toString("base64")}` });
      continue;
    }
    const raw = bytes.toString("utf8").replace(/^﻿/, "");
    const text = HTMLS.has(ext) ? htmlToText(raw) : tidy(raw);
    if (text === "") {
      throw new ImportError(
        path,
        "menu text",
        "none (a page drawn by scripts has no text in its HTML: save it as text or take a screenshot)",
      );
    }
    const pieces = splitText(text, budget);
    pieces.forEach((t, i) => {
      parts.push({ file: name, label: `part ${i + 1} of ${pieces.length}`, text: t });
    });
  }
  return parts;
}
