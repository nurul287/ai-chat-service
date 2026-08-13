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
    plaintext: z.string().describe("Shown exactly once — store it now, it cannot be retrieved again."),
    prefix: z.string(),
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
