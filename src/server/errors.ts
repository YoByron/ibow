/** HTTP error type and the request context shared by the API and the streams. */

import type { Session } from "../store/store.ts";

export type Env = { Variables: { session: Session | undefined } };

/** An HTTP failure with a machine-readable code; the message says what was expected and what was found. */
export class ApiError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 429;
  readonly code: string;
  constructor(status: ApiError["status"], code: string, message: string) {
    super(`${code}: ${message}`);
    this.status = status;
    this.code = code;
  }
}
