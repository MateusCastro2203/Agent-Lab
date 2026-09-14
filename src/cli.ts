// Process-ending helpers live here, not in db/client.ts, so a script with no
// database can use them without pulling in `pg`.

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
