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
