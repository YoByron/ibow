// Writes a consistent copy of the install's database, safe while ibow is serving: npm run backup -- <file>
// Reads DATA_DIR from the environment or .env (default ./data). Refuses to overwrite a file.
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { backupDatabase, databaseKind } from "../src/store/node.ts";

try {
  const dest = process.argv[2];
  if (dest === undefined)
    throw new Error("backup: expected the file to write, found nothing; npm run backup -- <file>");
  const db = join(resolve(process.env.DATA_DIR || "./data"), "ibow.db");
  // Checked first, for a clear message rather than SQLite's.
  if (databaseKind(db) === "missing")
    throw new Error(`backup: expected a database at ${db}, found none; check DATA_DIR`);
  mkdirSync(dirname(resolve(dest)), { recursive: true });
  backupDatabase(db, resolve(dest));
  console.log(`backup: ${db} copied to ${resolve(dest)}`);
} catch (e) {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
}
