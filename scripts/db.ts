import { readFile } from "node:fs/promises";
import { Client } from "pg";

const DEFAULT_URL = "postgres://agentlab:agentlab@localhost:5433/agentlab";
const url = process.env.DATABASE_URL ?? DEFAULT_URL;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// Connecting to `localhost` tries IPv6 and IPv4, and the failure arrives as an
// AggregateError whose own `message` is empty — the causes are in `.errors`.
// Reading only `.message` printed a blank reason, so unwrap the aggregate.
function describe(error: unknown): string {
  if (error instanceof AggregateError) {
    const causes = error.errors.map(describe).filter((m) => m !== "");
    const unique = [...new Set(causes)];
    if (unique.length > 0) return unique.join("; ");
  }
  if (error instanceof Error && error.message !== "") return error.message;
  return String(error);
}

function unreachable(reason: string): never {
  fail(
    `Cannot reach Postgres at ${url}\n` +
      `  ${reason}\n\n` +
      `Is the container up? Start it and wait for the healthcheck:\n` +
      `  docker compose up -d\n` +
      `  docker compose ps        # db should read "healthy"\n`,
  );
}

async function connect(): Promise<Client> {
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
  } catch (error) {
    unreachable(describe(error));
  }
  return client;
}

async function setup(): Promise<void> {
  const schema = await readFile("db/schema.sql", "utf8");
  const client = await connect();
  try {
    await client.query(schema);
    console.log(`applied db/schema.sql to ${url}`);
  } finally {
    await client.end();
  }
  await check();
}

async function check(): Promise<void> {
  const client = await connect();
  try {
    const ext = await client.query<{ extversion: string }>(
      "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
    );
    const version = ext.rows[0]?.extversion;
    if (version === undefined) {
      fail("the `vector` extension is not installed — run `npm run db:setup`");
    }

    const table = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'chunks'
       ) AS exists`,
    );
    if (table.rows[0]?.exists !== true) {
      fail("table `chunks` is missing — run `npm run db:setup`");
    }

    const counts = await client.query<{ rows: string; embedded: string }>(
      `SELECT count(*) AS rows, count(embedding) AS embedded FROM chunks`,
    );
    const row = counts.rows[0];
    // `SHOW server_version` names its column server_version, and its value
    // carries the packaging suffix — "17.11 (Debian 17.11-1.pgdg13+2)". The
    // image tag already records the build, so keep just the version number.
    const server = await client.query<{ server_version: string }>("SHOW server_version");
    const serverVersion = server.rows[0]?.server_version.split(" ")[0] ?? "?";

    console.log(`postgres ${serverVersion}, pgvector ${version}`);
    console.log(`chunks: ${row?.rows ?? "0"} rows, ${row?.embedded ?? "0"} embedded`);
    console.log("db OK");
  } finally {
    await client.end();
  }
}

const command = process.argv[2];
if (command === "setup") {
  await setup();
} else if (command === "check") {
  await check();
} else {
  fail(`usage: db.ts <setup|check>  (got ${command ?? "nothing"})`);
}
