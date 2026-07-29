import { afterEach, describe, expect, it } from "vitest";
import { assertLocalDatabase } from "./local-db-guard";

afterEach(() => {
  delete process.env.ALLOW_NONLOCAL_TEST_DB;
});

describe("assertLocalDatabase", () => {
  it("allows the local Supabase stack", () => {
    expect(() =>
      assertLocalDatabase("postgresql://postgres:postgres@127.0.0.1:55322/postgres"),
    ).not.toThrow();
  });

  it("allows localhost, which is what CI uses", () => {
    expect(() =>
      assertLocalDatabase("postgresql://postgres:postgres@localhost:5432/postgres"),
    ).not.toThrow();
  });

  it("allows a container network host", () => {
    expect(() =>
      assertLocalDatabase("postgresql://u:p@postgres.railway.internal:5432/railway"),
    ).not.toThrow();
  });

  it("refuses a hosted Supabase direct connection", () => {
    expect(() =>
      assertLocalDatabase("postgresql://postgres:p@db.abcdefgh.supabase.co:5432/postgres"),
    ).toThrow(/Refusing to run tests against a non-local database/);
  });

  it("refuses a hosted Supabase pooler connection", () => {
    expect(() =>
      assertLocalDatabase(
        "postgresql://postgres.abc:p@aws-1-eu-north-1.pooler.supabase.com:6543/postgres",
      ),
    ).toThrow(/Refusing/);
  });

  it("names the offending host so the fix is obvious", () => {
    expect(() =>
      assertLocalDatabase("postgresql://postgres:p@db.abcdefgh.supabase.co:5432/postgres"),
    ).toThrow(/db\.abcdefgh\.supabase\.co/);
  });

  it("refuses when DATABASE_URL is unset", () => {
    expect(() => assertLocalDatabase(undefined)).toThrow(/DATABASE_URL is not set/);
  });

  it("allows an explicit opt-out for a remote throwaway database", () => {
    process.env.ALLOW_NONLOCAL_TEST_DB = "1";
    expect(() =>
      assertLocalDatabase("postgresql://postgres:p@db.abcdefgh.supabase.co:5432/postgres"),
    ).not.toThrow();
  });
});
