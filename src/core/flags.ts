/**
 * Feature flags (D-075): switches an install's people may change while it runs. Two scopes, by who may flip them: `look`
 * (the theme's features, which are the menu's and the storefront's switches) belong to the owner; `system` ones belong to the
 * admin; `ops` ones (D-101) belong to the manager and the owner. The definitions and the checks are pure; where values live and who flipped them is the store's and the server's.
 */

import { TAG_MODES, type Theme, TILE_MODES } from "./theme.ts";

export type FlagValue = boolean | number | string;
export type FlagScope = "look" | "system" | "ops";

export interface FlagDef {
  /** `ai`, `retentionDays`, `showcase`; `ops.<name>` for an operations switch; or `features.<name>` for a look flag. */
  key: string;
  scope: FlagScope;
  kind: "boolean" | "number" | "choice";
  /** One line for the hub: what flipping it does. */
  what: string;
  min?: number;
  max?: number;
  choices?: readonly string[];
}

export const SYSTEM_FLAGS: readonly FlagDef[] = [
  {
    key: "ai",
    scope: "system",
    kind: "boolean",
    what: "The AI analyst on the owner's dashboard; on only where a model is set up",
  },
  {
    key: "retentionDays",
    scope: "system",
    kind: "number",
    min: 1,
    max: 3650,
    what: "Days before customer names, review text and line notes are cleared",
  },
  { key: "showcase", scope: "system", kind: "boolean", what: "Serve the ibow showcase page at /showcase" },
];

/** The operations switches (D-101): how the floor runs today, flipped by the manager or the owner. */
export const OPS_FLAGS: readonly FlagDef[] = [
  { key: "ops.upi", scope: "ops", kind: "boolean", what: "Guests may pay by UPI; on only where UPI is set up" },
  {
    key: "ops.counterFirst",
    scope: "ops",
    kind: "boolean",
    what: "Orders reach the stations only once the counter has confirmed payment; room-bill orders go straight through",
  },
  { key: "ops.messages", scope: "ops", kind: "boolean", what: "Guests may message their runner" },
  { key: "ops.sections", scope: "ops", kind: "boolean", what: "Runners see their own sections first" },
];

/** Each operations switch's value until someone flips it: off only where on would change how an install already runs. */
export const OPS_DEFAULTS: Readonly<Record<string, boolean>> = {
  "ops.upi": true,
  "ops.counterFirst": false,
  "ops.messages": true,
  "ops.sections": true,
};

const LOOK_WHAT: Record<string, string> = {
  favourites: "Customers may star items",
  recent: "Show customers their recent orders",
  tags: "Bestseller and new tags on items: off, from the catalog, or worked out from sales",
  veg: "The veg-only toggle on the menu",
  darkToggle: "The dark-mode button",
  cartEta: "A typical wait time in the cart",
  tiles: "Item cards: always a tile, or a picture only where there is a photo",
  featured: "A Most loved strip at the top of the menu",
};

/** The look flags of a theme: one per feature, named `features.<name>`. */
export function lookFlags(features: Theme["features"]): FlagDef[] {
  return Object.keys(features).map((name): FlagDef => {
    const key = `features.${name}`;
    const what = LOOK_WHAT[name] ?? name;
    if (name === "tags") return { key, scope: "look", kind: "choice", choices: TAG_MODES, what };
    if (name === "tiles") return { key, scope: "look", kind: "choice", choices: TILE_MODES, what };
    return { key, scope: "look", kind: "boolean", what };
  });
}

export class FlagError extends Error {
  readonly code: "no_such_flag" | "bad_flag_value";
  constructor(code: FlagError["code"], message: string) {
    super(`${code}: ${message}`);
    this.name = "FlagError";
    this.code = code;
  }
}

/** The value a flag may take, or a `FlagError` saying what was expected and what was found. */
export function checkFlag(def: FlagDef, raw: unknown): FlagValue {
  const found = JSON.stringify(raw);
  if (def.kind === "boolean") {
    if (typeof raw !== "boolean")
      throw new FlagError("bad_flag_value", `${def.key}: expected true or false, found ${found}`);
    return raw;
  }
  if (def.kind === "number") {
    const { min = 0, max = Number.MAX_SAFE_INTEGER } = def;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
      throw new FlagError(
        "bad_flag_value",
        `${def.key}: expected a whole number from ${min} to ${max}, found ${found}`,
      );
    }
    return raw;
  }
  const choices = def.choices ?? [];
  if (typeof raw !== "string" || !choices.includes(raw)) {
    throw new FlagError("bad_flag_value", `${def.key}: expected one of ${choices.join(", ")}, found ${found}`);
  }
  return raw;
}

export interface FlagChange {
  key: string;
  from: FlagValue | null;
  to: FlagValue;
}

/** The look flags that differ between two themes' features, for the audit of an Appearance save. */
export function diffFeatures(before: Theme["features"], after: Theme["features"]): FlagChange[] {
  const out: FlagChange[] = [];
  for (const [name, to] of Object.entries(after)) {
    const from = (before as Record<string, FlagValue>)[name];
    if (from !== to) out.push({ key: `features.${name}`, from: from ?? null, to: to as FlagValue });
  }
  return out;
}
