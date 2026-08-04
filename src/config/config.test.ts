import { describe, expect, it } from "vitest";
import { parseConfig } from "./index";

const valid = {
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:55322/postgres",
  VOYAGE_API_KEY: "pa-test-key",
  VOYAGE_EMBEDDING_MODEL: "voyage-3",
  PORT: "4000",
  NODE_ENV: "test",
  OPENROUTER_API_KEY: "or-test-key",
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

  describe("PUBLIC_URL", () => {
    it("is undefined when absent", () => {
      expect(parseConfig(valid).PUBLIC_URL).toBeUndefined();
    });

    it("accepts a fully-formed URL as-is", () => {
      const config = parseConfig({ ...valid, PUBLIC_URL: "https://api.example.com" });
      expect(config.PUBLIC_URL).toBe("https://api.example.com");
    });

    // Railway's own dashboard shows a service's public domain WITHOUT a
    // scheme (e.g. "my-app-production.up.railway.app"), and its own injected
    // env vars (RAILWAY_PUBLIC_DOMAIN, RAILWAY_STATIC_URL) are bare domains
    // too — so a bare domain here is the value a deploying user is most
    // likely to paste, not an edge case. Crashing on it took down five
    // consecutive deploys before this was diagnosed.
    it("accepts a bare domain and adds https://", () => {
      const config = parseConfig({
        ...valid,
        PUBLIC_URL: "ai-chat-service-production-acc4.up.railway.app",
      });
      expect(config.PUBLIC_URL).toBe("https://ai-chat-service-production-acc4.up.railway.app");
    });

    it("still rejects genuine garbage", () => {
      expect(() => parseConfig({ ...valid, PUBLIC_URL: "not a url at all!!" })).toThrow(
        /PUBLIC_URL/,
      );
    });
  });
});

describe("chat model config", () => {
  it("defaults to openrouter with the free deepseek model", () => {
    const config = parseConfig({ ...valid, OPENROUTER_API_KEY: "or-test-key" });
    expect(config.CHAT_MODEL_PROVIDER).toBe("openrouter");
    expect(config.CHAT_MODEL_ID).toBe("deepseek/deepseek-r1:free");
  });

  it("requires OPENROUTER_API_KEY when the provider is openrouter", () => {
    const { OPENROUTER_API_KEY: _k, ...rest } = valid;
    expect(() => parseConfig({ ...rest, CHAT_MODEL_PROVIDER: "openrouter" })).toThrow(
      /OPENROUTER_API_KEY/,
    );
  });

  it("does not require OPENROUTER_API_KEY when the provider is anthropic", () => {
    const { OPENROUTER_API_KEY: _k, ...rest } = valid;
    const config = parseConfig({
      ...rest,
      CHAT_MODEL_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-test",
    });
    expect(config.OPENROUTER_API_KEY).toBeUndefined();
  });

  it("requires ANTHROPIC_API_KEY when the provider is anthropic", () => {
    expect(() =>
      parseConfig({ ...valid, CHAT_MODEL_PROVIDER: "anthropic", OPENROUTER_API_KEY: "or-key" }),
    ).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("rejects an unknown CHAT_MODEL_PROVIDER", () => {
    expect(() =>
      parseConfig({ ...valid, CHAT_MODEL_PROVIDER: "openai", OPENROUTER_API_KEY: "or-key" }),
    ).toThrow(/CHAT_MODEL_PROVIDER/);
  });
});
