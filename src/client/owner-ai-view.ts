/** Pure parts of the AI analyst's panel, kept apart from the DOM so they can be tested. */

export interface Segment {
  text: string;
  /** A number (or citation) the server's check couldn't back. */
  unbacked: boolean;
}

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The answer cut into plain and unbacked pieces, so the page can mark the unbacked ones. A number is matched only
 * where it stands alone (no digit right before or after), so `3` isn't marked inside `2026-11-03`.
 */
export function markUnbacked(text: string, unverified: readonly string[]): Segment[] {
  const wanted = [...new Set(unverified)].filter((u) => u !== "").sort((a, b) => b.length - a.length);
  if (wanted.length === 0) return [{ text, unbacked: false }];
  const re = new RegExp(`(?<![0-9])(?:${wanted.map(literal).join("|")})(?![0-9])`, "gu");
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at), unbacked: false });
    out.push({ text: m[0], unbacked: true });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), unbacked: false });
  return out;
}
