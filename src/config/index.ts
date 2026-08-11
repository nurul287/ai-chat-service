import "dotenv/config";
import { z } from "zod";

const baseConfigSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  VOYAGE_API_KEY: z.string().min(1, "VOYAGE_API_KEY is required"),
  VOYAGE_EMBEDDING_MODEL: z.string().default("voyage-3"),
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  // Optional on purpose — a new REQUIRED var breaks every test until it is also
  // added to CI's env block. When set (on Railway), it becomes the primary
  // `servers` entry in the published OpenAPI spec so generated clients point at
  // the real deployment rather than localhost.
  //
  // Accepts a bare domain, not just a full URL, and prepends https:// before
  // validating. Railway's own dashboard shows a service's public domain WITHOUT
  // a scheme, and Railway's own injected vars (RAILWAY_PUBLIC_DOMAIN,
  // RAILWAY_STATIC_URL) are bare domains too — a strict z.string().url() here
  // crashed at import time on exactly the value Railway's UI hands you to
  // paste, which took down five consecutive deploys before being diagnosed.
  PUBLIC_URL: z
    .string()
    .optional()
    .transform((value) => (value && !/^https?:\/\//.test(value) ? `https://${value}` : value))
    .pipe(z.string().url().optional()),
  CHAT_MODEL_PROVIDER: z.enum(["openrouter", "anthropic"]).default("openrouter"),
  CHAT_MODEL_ID: z.string().default("deepseek/deepseek-r1:free"),
  OPENROUTER_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  // AES-256-GCM key for tenant tool secrets (the HMAC secret and optional
  // auth header value) — these must be readable back to sign/authenticate
  // outgoing requests, unlike api_keys.key_hash which only ever needs
  // one-way comparison. 64 hex characters = 32 bytes.
  TOOL_SECRETS_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "must be a 64-character hex string (32 bytes)"),
});

const configSchema = baseConfigSchema.superRefine((data, ctx) => {
  if (data.CHAT_MODEL_PROVIDER === "openrouter" && !data.OPENROUTER_API_KEY) {
    ctx.addIssue({
      code: "custom",
      path: ["OPENROUTER_API_KEY"],
      message: "OPENROUTER_API_KEY is required when CHAT_MODEL_PROVIDER is openrouter",
    });
  }
  if (data.CHAT_MODEL_PROVIDER === "anthropic" && !data.ANTHROPIC_API_KEY) {
    ctx.addIssue({
      code: "custom",
      path: ["ANTHROPIC_API_KEY"],
      message: "ANTHROPIC_API_KEY is required when CHAT_MODEL_PROVIDER is anthropic",
    });
  }
});

export type Config = z.infer<typeof configSchema>;

/**
 * Parses and validates an environment. Exported separately from `config` so
 * tests can exercise validation without mutating process.env — and so a
 * missing var fails loudly at boot with the variable's name, never as an
 * undefined-at-runtime surprise.
 *
 * `dotenv/config` is imported for its side effect above: it populates
 * process.env from `.env` for local dev, tests, and CLI scripts. In production
 * (Railway) there is no `.env` file and the platform supplies real env vars,
 * so the import is a harmless no-op.
 */
export function parseConfig(env: Record<string, string | undefined>): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration — ${issues}`);
  }
  return result.data;
}

export const config = parseConfig(process.env);
