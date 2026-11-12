// Reads GitHub's check-runs reply for a commit and says whether CI is done and green. Used by update.sh with the pinned
// Node (`node ci-status.ts < reply.json` prints one word); the logic is a function so a test can pin it.
//   success: every run completed, each one success, skipped or neutral
//   failure: some run completed without success (cancelled, timed out, failed...), even if others are still running
//   pending: some run has not completed
//   none:    no runs at all yet (the workflow has not started)

export type CiState = "success" | "failure" | "pending" | "none";

const PASSING = new Set(["success", "skipped", "neutral"]);

export function ciState(body: unknown): CiState {
  const runs = (body as { check_runs?: unknown } | null)?.check_runs;
  if (!Array.isArray(runs)) {
    throw new Error("ci-status: expected a check-runs reply with a check_runs list, found something else");
  }
  if (runs.length === 0) return "none";
  const list = runs as { status?: string; conclusion?: string | null }[];
  if (list.some((r) => r.status === "completed" && !PASSING.has(r.conclusion ?? ""))) return "failure";
  if (list.some((r) => r.status !== "completed")) return "pending";
  return "success";
}

if (import.meta.main) {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  try {
    console.log(ciState(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(2);
  }
}
