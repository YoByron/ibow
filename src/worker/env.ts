import type { DurableObjectNamespace, Fetcher } from "cloudflare:workers";

/** The Worker's bindings, vars and secrets (wrangler.toml, `wrangler secret put`). */
export interface Bindings {
  INSTALL: DurableObjectNamespace;
  ASSETS: Fetcher;
  /** `1` on a demo install (D-035); anything else but empty is refused. */
  DEMO?: string;
  /** Secret: the owner's PIN hash from `npm run hash-pin`. Not used by a demo, which makes its own PINs. */
  OWNER_PIN_HASH?: string;
  /** Secret: the system admin's PIN hash (`npx wrangler secret put ADMIN_PIN_HASH`); without it nobody can sign in as admin. */
  ADMIN_PIN_HASH?: string;
  /** Secret or var, once: a new id for a staff member saved as `admin` before D-072 (its boot check names it). */
  RENAME_ADMIN_STAFF?: string;
  UPI_VPA?: string;
  UPI_PAYEE_NAME?: string;
  AI_BASE_URL?: string;
  AI_MODEL?: string;
  AI_API_KEY?: string;
  AI_ADAPTER?: string;
  AI_TIMEOUT_SECONDS?: string;
}

/** The string settings among the bindings, which is all the AI door reads. */
export function strings(env: Bindings): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") out[k] = v;
  return out;
}
