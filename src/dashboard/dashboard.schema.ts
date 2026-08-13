import { z } from "zod";

export const signupBody = z.object({
  tenantName: z.string().min(1).max(255),
  tenantSlug: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-z0-9-]+$/, "lowercase letters, numbers, and hyphens only"),
});

export const tenantResponse = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.string(),
});

export const signupResponse = z.object({
  tenant: tenantResponse,
  apiKey: z.object({
    id: z.string(),
    name: z.string(),
    keyPrefix: z.string(),
    plaintext: z.string().describe("Shown exactly once — store it now, it cannot be retrieved again."),
  }),
});

export const apiKeyResponse = z.object({
  id: z.string(),
  name: z.string(),
  keyPrefix: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const createKeyBody = z.object({
  name: z.string().min(1).max(255),
});

export const createKeyResponse = z.object({
  id: z.string(),
  name: z.string(),
  keyPrefix: z.string(),
  plaintext: z.string().describe("Shown exactly once — store it now, it cannot be retrieved again."),
});

export const revokeKeyParams = z.object({
  id: z.string().uuid(),
});

export const widgetConfigResponse = z.object({
  allowedOrigins: z.array(z.string()),
  keyPrefix: z.string().nullable(),
  hasPublishableKey: z.boolean(),
});

export const setOriginsBody = z.object({
  origins: z
    .array(
      z
        .string()
        .url()
        .refine(
          (v) => {
            // Zod 4 does NOT short-circuit this refine when the preceding
            // .url() check already failed — both run on the same value
            // regardless. `new URL(v)` throws a raw TypeError for a
            // non-URL string (no scheme, empty string, etc.), and
            // fastify-type-provider-zod's safeParse() does not catch an
            // exception thrown from inside a refinement, so an uncaught
            // throw here reaches the app's global error handler as an
            // unauthenticated 500 (schema validation runs before any
            // preHandler, including the bearer-token check) instead of a
            // clean 400. Must catch and return false, never throw.
            try {
              return new URL(v).origin === v;
            } catch {
              return false;
            }
          },
          { message: "must be a bare origin with no path or trailing slash, e.g. https://acme.com" },
        ),
    )
    .max(50),
});

export const mintPublishableKeyResponse = z.object({
  plaintext: z.string().describe("Shown exactly once — store it now, it cannot be retrieved again."),
  keyPrefix: z.string(),
});

export const usageQuery = z.object({
  days: z.coerce.number().int().positive().max(365).default(30),
});

export const usagePoint = z.object({
  date: z.string(),
  messages: z.number(),
  tokens: z.number(),
});

export const usageResponse = z.object({
  data: z.array(usagePoint),
  totals: z.object({
    conversations: z.number(),
    messages: z.number(),
    tokens: z.number(),
  }),
});
