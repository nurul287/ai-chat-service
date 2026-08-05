import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./crypto";

describe("crypto", () => {
  it("round-trips a secret through encrypt then decrypt", () => {
    const plaintext = "whsec_abc123";
    const stored = encryptSecret(plaintext);
    expect(decryptSecret(stored)).toBe(plaintext);
  });

  it("never stores the plaintext as-is", () => {
    const plaintext = "whsec_abc123";
    const stored = encryptSecret(plaintext);
    expect(stored).not.toContain(plaintext);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const plaintext = "whsec_abc123";
    expect(encryptSecret(plaintext)).not.toBe(encryptSecret(plaintext));
  });

  it("throws when the stored value has been tampered with", () => {
    const stored = encryptSecret("whsec_abc123");
    const tampered = stored.slice(0, -4) + "abcd";
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("round-trips an empty string through encrypt then decrypt", () => {
    const plaintext = "";
    const stored = encryptSecret(plaintext);
    expect(decryptSecret(stored)).toBe(plaintext);
  });

  it("throws when the stored value is malformed (no colons)", () => {
    expect(() => decryptSecret("not-a-valid-format")).toThrow();
  });
});
