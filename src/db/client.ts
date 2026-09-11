import { Client } from "pg";

const DEFAULT_URL = "postgres://agentlab:agentlab@localhost:5433/agentlab";

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_URL;
}

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// Connecting to `localhost` tries IPv6 and IPv4, and the failure arrives as an
// AggregateError whose own `message` is empty — the causes are in `.errors`.
// Reading only `.message` printed a blank reason, so unwrap the aggregate.
export function describe(error: unknown): string {
  if (error instanceof AggregateError) {
    const causes = error.errors.map(describe).filter((m) => m !== "");
    const unique = [...new Set(causes)];
    if (unique.length > 0) return unique.join("; ");
  }
  if (error instanceof Error && error.message !== "") return error.message;
  return String(error);
}

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
