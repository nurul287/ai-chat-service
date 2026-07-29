/**
 * Refuses to run the test suite against anything but a local database.
 *
 * The suite truncates `tenants`, `api_keys`, `documents` and `chunks` between
 * files. Pointing `.env` at production — which is a normal thing to do briefly
 * while running `pnpm create-tenant` against it — turns a routine `pnpm test`
 * into silent, irreversible production data loss.
 *
 * Documenting that hazard is not enough, because the dangerous state looks
 * exactly like the safe one. So it is enforced here instead: the suite refuses
 * to start rather than trusting whoever edited `.env` last.
 */

// vitest's globalSetup runs before any test module imports src/config, so
// nothing has loaded `.env` yet. Load it here or the guard sees an empty
// environment and reports "not set" for what is really a production URL.
import "dotenv/config";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "postgres", "db"]);

export function assertLocalDatabase(databaseUrl: string | undefined): void {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set — the test suite needs a local database.");
  }

  if (process.env.ALLOW_NONLOCAL_TEST_DB === "1") return;

  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    throw new Error(`DATABASE_URL is not a valid connection URL: ${databaseUrl}`);
  }

  // `.internal` covers container networks (Railway, Fly, docker-compose), which
  // is how CI-like environments address a throwaway database.
  if (LOCAL_HOSTS.has(host) || host.endsWith(".internal")) return;

  throw new Error(
    [
      "",
      "  Refusing to run tests against a non-local database.",
      "",
      `  DATABASE_URL points at: ${host}`,
      "",
      "  The test suite TRUNCATES tenants, api_keys, documents and chunks.",
      "  Running it against a remote database would destroy that data.",
      "",
      "  Point DATABASE_URL back at your local stack, e.g.",
      "    postgresql://postgres:postgres@127.0.0.1:55322/postgres",
      "",
      "  If you genuinely mean to target a remote throwaway database, set",
      "  ALLOW_NONLOCAL_TEST_DB=1.",
      "",
    ].join("\n"),
  );
}

export default function setup(): void {
  assertLocalDatabase(process.env.DATABASE_URL);
}
