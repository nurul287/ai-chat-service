import { describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey } from "./api-key";

describe("generateApiKey", () => {
  it("produces a prefixed plaintext key", () => {
    const { plaintext } = generateApiKey();
    expect(plaintext.startsWith("sk_live_")).toBe(true);
    expect(plaintext.length).toBeGreaterThan(40);
  });

  it("returns a prefix that is the leading 12 chars of the plaintext", () => {
    const { plaintext, prefix } = generateApiKey();
    expect(prefix).toBe(plaintext.slice(0, 12));
  });

  it("returns a hash matching hashApiKey of the plaintext", () => {
    const { plaintext, hash } = generateApiKey();
    expect(hash).toBe(hashApiKey(plaintext));
  });

  it("never repeats a key", () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey().plaintext));
    expect(keys.size).toBe(200);
  });

  it("defaults to a secret key with the sk_live_ prefix", () => {
    const { plaintext } = generateApiKey();
    expect(plaintext.startsWith("sk_live_")).toBe(true);
  });

  it("generates a publishable key with the pk_live_ prefix", () => {
    const { plaintext } = generateApiKey("publishable");
    expect(plaintext.startsWith("pk_live_")).toBe(true);
  });
});

describe("hashApiKey", () => {
  it("is deterministic", () => {
    expect(hashApiKey("sk_live_abc")).toBe(hashApiKey("sk_live_abc"));
  });

  it("differs for different inputs", () => {
    expect(hashApiKey("sk_live_abc")).not.toBe(hashApiKey("sk_live_abd"));
  });

  it("returns a 64-char hex digest", () => {
    expect(hashApiKey("sk_live_abc")).toMatch(/^[0-9a-f]{64}$/);
  });
});
