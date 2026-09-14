import { Client } from "pg";
import { fail, describe } from "../cli.ts";

const DEFAULT_URL = "postgres://agentlab:agentlab@localhost:5433/agentlab";

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_URL;
}

// Re-exported, not just imported: scripts/eval.ts and scripts/ingest.ts
// already import `fail` from here, and src/db/client.test.ts already imports
// `describe` from here — re-exporting both keeps those import lines from
// churning even though the implementations now live in ../cli.ts.
export { fail, describe } from "../cli.ts";

export async function connect(): Promise<Client> {
  const url = databaseUrl();
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
  } catch (error) {
    fail(
      `Cannot reach Postgres at ${url}\n` +
        `  ${describe(error)}\n\n` +
        `Is the container up? Start it and wait for the healthcheck:\n` +
        `  docker compose up -d\n` +
        `  docker compose ps        # db should read "healthy"\n`,
    );
  }
  return client;
}
