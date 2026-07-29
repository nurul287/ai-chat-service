import { createHash, randomBytes } from "node:crypto";

const KEY_PREFIX = "sk_live_";
const PREFIX_LENGTH = 12;

/**
 * SHA-256 rather than a slow KDF (bcrypt/argon2) on purpose: an API key is a
 * 256-bit random value, not a human-chosen password, so it has no meaningful
 * dictionary/brute-force surface — and this runs on every authenticated
 * request, where a deliberately slow hash would be a latency tax on the hot
 * path.
 */
export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export function generateApiKey(): { plaintext: string; prefix: string; hash: string } {
  const plaintext = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return {
    plaintext,
    prefix: plaintext.slice(0, PREFIX_LENGTH),
    hash: hashApiKey(plaintext),
  };
}
