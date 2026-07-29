import "dotenv/config";
import { z } from "zod";

const configSchema = z.object({
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
  PUBLIC_URL: z.string().url().optional(),
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
