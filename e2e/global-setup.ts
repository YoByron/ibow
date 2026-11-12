import { buildClient } from "../scripts/build-client.ts";

/** The tests run against the built client, exactly what `npm start` serves. */
export default async function globalSetup(): Promise<void> {
  await buildClient();
}
