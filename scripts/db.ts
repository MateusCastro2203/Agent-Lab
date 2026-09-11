import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

const DEFAULT_URL = "postgres://agentlab:agentlab@localhost:5433/agentlab";
const url = process.env.DATABASE_URL ?? DEFAULT_URL;
const SCHEMA_PATH = "db/schema.sql";

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

// Fingerprint of the schema's meaning, not its bytes: comments and whitespace
// are stripped so that editing the file's prose cannot raise a false drift
// alarm — a false alarm costs a re-ingest, so it is worth avoiding.
function fingerprint(sql: string): string {
  const meaningful = sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, "").trim())
    .filter((line) => line !== "")
    .join(" ")
    .replace(/\s+/g, " ");
  return createHash("sha256").update(meaningful).digest("hex");
}

async function readSchema(): Promise<{ sql: string; hash: string }> {
  const sql = await readFile(SCHEMA_PATH, "utf8");
  return { sql, hash: fingerprint(sql) };
}

async function recordedHash(client: Client): Promise<string | null> {
  const exists = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'schema_meta'
     ) AS exists`,
  );
  if (exists.rows[0]?.exists !== true) return null;
  const row = await client.query<{ hash: string }>("SELECT hash FROM schema_meta WHERE id = 1");
  return row.rows[0]?.hash ?? null;
}

async function setup(): Promise<void> {
  const { sql, hash } = await readSchema();
  const client = await connect();
  try {
    await client.query(sql);
    await client.query(
      `INSERT INTO schema_meta (id, hash) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET hash = excluded.hash, applied_at = now()`,
      [hash],
    );
    console.log(`applied ${SCHEMA_PATH} to ${url}`);
  } finally {
    await client.end();
  }
  await check();
}

async function check(): Promise<void> {
  const { hash } = await readSchema();
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

    const applied = await recordedHash(client);
    if (applied === null) {
      fail(
        `no schema fingerprint recorded — this database predates the check.\n` +
          `Run \`npm run db:setup\` to record one.`,
      );
    }
    if (applied !== hash) {
      const counts = await client.query<{ embedded: string }>(
        "SELECT count(embedding) AS embedded FROM chunks",
      );
      fail(
        `SCHEMA DRIFT — ${SCHEMA_PATH} no longer matches what was applied.\n` +
          `  applied:  ${applied}\n` +
          `  on disk:  ${hash}\n\n` +
          `Every statement in the schema is IF NOT EXISTS, so re-running ` +
          `db:setup will NOT apply the change.\n` +
          `Reapply from scratch with:\n` +
          `  npm run db:reset -- --force\n\n` +
          `That drops the tables. ${counts.rows[0]?.embedded ?? "0"} embedded ` +
          `row(s) would be lost and need a re-ingest.`,
      );
    }

    // `SHOW server_version` names its column server_version, and its value
    // carries the packaging suffix — "17.11 (Debian 17.11-1.pgdg13+2)". The
    // image tag already records the build, so keep just the version number.
    const server = await client.query<{ server_version: string }>("SHOW server_version");
    const serverVersion = server.rows[0]?.server_version.split(" ")[0] ?? "?";

    const counts = await client.query<{ rows: string; embedded: string }>(
      `SELECT count(*) AS rows, count(embedding) AS embedded FROM chunks`,
    );
    const row = counts.rows[0];

    console.log(`postgres ${serverVersion}, pgvector ${version}`);
    console.log(`chunks: ${row?.rows ?? "0"} rows, ${row?.embedded ?? "0"} embedded`);
    console.log(`schema: ${hash.slice(0, 12)} (matches)`);
    console.log("db OK");
  } finally {
    await client.end();
  }
}

async function reset(): Promise<void> {
  const force = process.argv.includes("--force");
  const client = await connect();
  let embedded = "0";
  let closed = false;
  try {
    const table = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'chunks'
       ) AS exists`,
    );
    if (table.rows[0]?.exists === true) {
      const counts = await client.query<{ embedded: string }>(
        "SELECT count(embedding) AS embedded FROM chunks",
      );
      embedded = counts.rows[0]?.embedded ?? "0";
    }

    if (!force) {
      await client.end();
      closed = true;
      fail(
        `db:reset drops the tables in ${url} and reapplies ${SCHEMA_PATH}.\n` +
          `${embedded} embedded row(s) would be lost and need a re-ingest.\n\n` +
          `Re-run with the flag if that is what you want:\n` +
          `  npm run db:reset -- --force`,
      );
    }

    await client.query("DROP TABLE IF EXISTS chunks, schema_meta");
    console.log(`dropped chunks and schema_meta (${embedded} embedded row(s) discarded)`);
  } finally {
    if (!closed) await client.end();
  }
  await setup();
}

const command = process.argv[2];
if (command === "setup") {
  await setup();
} else if (command === "check") {
  await check();
} else if (command === "reset") {
  await reset();
} else {
  fail(`usage: db.ts <setup|check|reset>  (got ${command ?? "nothing"})`);
}
