import type { Options } from "postgres";

/**
 * Two facts about hosted Postgres that a localhost-only setup never exercises,
 * and that both fail in confusing ways if left to the defaults:
 *
 * 1. **TLS.** postgres.js does not negotiate SSL unless asked. A managed
 *    provider (Supabase, Neon, RDS) refuses the connection without it.
 * 2. **Prepared statements vs. transaction pooling.** Supabase's transaction
 *    pooler multiplexes one server connection across many clients, so a
 *    statement prepared by one client is invisible to the next. postgres.js
 *    prepares by default, which surfaces as intermittent
 *    "prepared statement does not exist" errors under concurrency — not at
 *    startup, which is what makes it expensive to diagnose.
 *
 * Derived from the URL rather than exposed as env vars, so there is no way to
 * deploy with a correct DATABASE_URL and a contradictory flag.
 */
export function buildClientOptions(databaseUrl: string): Options<Record<string, never>> {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error(`DATABASE_URL is not a valid connection URL: ${databaseUrl}`);
  }

  const host = url.hostname;

  // `.internal` covers Railway/Fly private networking, which does not
  // terminate TLS — requiring it there fails the connection outright.
  const isPrivate =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".internal");

  // 6543 is Supabase's transaction-pooler port; `pooler.` covers the hostname
  // form in case the port is proxied.
  const isTransactionPooled = url.port === "6543" || host.includes("pooler.");

  return {
    ...(isPrivate ? {} : { ssl: "require" as const }),
    ...(isTransactionPooled ? { prepare: false } : {}),
  };
}
