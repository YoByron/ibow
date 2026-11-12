/**
 * Repeat-customer badges from data ibow already has: the optional name a customer typed, within the retention period.
 * No phone, no account and no device id (brief, "Not"), so two customers who give the same name look like one; the
 * badge is a hint for the owner, never an identity. Pure.
 */

/** The same name however it was typed: Unicode-normalised, trimmed, inner spaces collapsed, case folded. */
export function nameKey(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
}

/**
 * For each name, the number of distinct business-local days before `beforeDay` on which it ordered. A name with 1 or
 * more is a returning customer today; several orders on one day count as one visit.
 */
export function earlierVisits(
  named: readonly { name: string; day: string }[],
  beforeDay: string,
): Record<string, number> {
  const days = new Map<string, Set<string>>();
  for (const { name, day } of named) {
    if (day >= beforeDay) continue;
    const key = nameKey(name);
    if (key === "") continue;
    const set = days.get(key) ?? new Set<string>();
    set.add(day);
    days.set(key, set);
  }
  const out: Record<string, number> = {};
  for (const [key, set] of days) out[key] = set.size;
  return out;
}
