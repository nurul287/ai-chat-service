import { describe, expect, it } from "vitest";
import { buildClientOptions } from "./connection-options";

describe("buildClientOptions", () => {
  it("always sets a connect timeout", () => {
    // server.ts pings the database before it listens. Without a bounded
    // connect, an unreachable host hangs past any healthcheck window and the
    // failure surfaces as "healthcheck failed" with nothing in the logs.
    for (const url of [
      "postgresql://postgres:postgres@127.0.0.1:55322/postgres",
      "postgresql://postgres:p@db.abcdefgh.supabase.co:5432/postgres",
      "postgresql://p:p@aws-1-ap-south-1.pooler.supabase.com:6543/postgres",
    ]) {
      expect(buildClientOptions(url).connect_timeout).toBe(10);
    }
  });

  it("does not require TLS for a local database", () => {
    const opts = buildClientOptions("postgresql://postgres:postgres@127.0.0.1:55322/postgres");
    expect(opts.ssl).toBeUndefined();
    expect(opts.prepare).toBeUndefined();
  });

  it("does not require TLS on a private container network", () => {
    // Railway's Postgres plugin is reached over private networking, which does
    // not terminate TLS — requiring it there fails the connection outright.
    const opts = buildClientOptions("postgresql://u:p@postgres.railway.internal:5432/railway");
    expect(opts.ssl).toBeUndefined();
  });

  it("requires TLS for a hosted database", () => {
    const opts = buildClientOptions(
      "postgresql://postgres:p@db.abcdefgh.supabase.co:5432/postgres",
    );
    expect(opts.ssl).toBe("require");
  });

  it("keeps prepared statements on a direct hosted connection", () => {
    const opts = buildClientOptions(
      "postgresql://postgres:p@db.abcdefgh.supabase.co:5432/postgres",
    );
    expect(opts.prepare).toBeUndefined();
  });

  it("disables prepared statements on Supabase's transaction pooler", () => {
    // The transaction-mode pooler multiplexes one server connection across many
    // clients, so a prepared statement from one client is invisible to the
    // next. postgres.js prepares by default; leaving it on produces
    // "prepared statement ... does not exist" under load, not at startup.
    const opts = buildClientOptions(
      "postgresql://postgres.abcdefgh:p@aws-0-eu-west-1.pooler.supabase.com:6543/postgres",
    );
    expect(opts.prepare).toBe(false);
    expect(opts.ssl).toBe("require");
  });

  it("disables prepared statements for any host on the pooler port", () => {
    const opts = buildClientOptions("postgresql://u:p@somehost.example.com:6543/postgres");
    expect(opts.prepare).toBe(false);
  });

  it("throws a readable error for an unparseable URL", () => {
    expect(() => buildClientOptions("not-a-url")).toThrow(/DATABASE_URL/);
  });
});
