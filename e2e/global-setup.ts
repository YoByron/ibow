import { buildClient } from "../scripts/build-client.ts";

/** The tests run against the built client, exactly what `npm start` serves. */
// Built once, here, and never again while the tests run: a test that starts the demo is told to skip its own build
// (IBOW_SKIP_BUILD), because a rebuild deletes the folder the other workers' servers are reading.
export default async function globalSetup(): Promise<void> {
  await buildClient();
}
