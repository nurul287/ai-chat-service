import { describe, expect, it } from "vitest";
import { parseConfig } from "./index";

const valid = {
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:55322/postgres",
  VOYAGE_API_KEY: "pa-test-key",
  VOYAGE_EMBEDDING_MODEL: "voyage-3",
  PORT: "4000",
  NODE_ENV: "test",
};

describe("parseConfig", () => {
  it("parses a valid environment", () => {
    const config = parseConfig(valid);
    expect(config.DATABASE_URL).toBe(valid.DATABASE_URL);
    expect(config.PORT).toBe(4000);
    expect(config.NODE_ENV).toBe("test");
  });

  it("defaults the embedding model, port and log level when absent", () => {
    const { VOYAGE_EMBEDDING_MODEL: _m, PORT: _p, ...rest } = valid;
    const config = parseConfig(rest);
    expect(config.VOYAGE_EMBEDDING_MODEL).toBe("voyage-3");
    expect(config.PORT).toBe(4000);
    expect(config.LOG_LEVEL).toBe("info");
  });

  it("throws a readable error naming the missing variable", () => {
    const { VOYAGE_API_KEY: _k, ...rest } = valid;
    expect(() => parseConfig(rest)).toThrow(/VOYAGE_API_KEY/);
  });

  it("rejects an unknown NODE_ENV", () => {
    expect(() => parseConfig({ ...valid, NODE_ENV: "staging" })).toThrow(/NODE_ENV/);
  });
});
