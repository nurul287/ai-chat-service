import { z } from "zod";

export const upsertDocumentBody = z.object({
  externalId: z
    .string()
    .min(1)
    .max(255)
    .describe(
      "Your own identifier for this document. Re-pushing the same externalId replaces the document rather than duplicating it.",
    ),
  title: z.string().max(500).optional(),
  content: z.string().min(1).max(200_000),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Arbitrary JSON returned alongside search results."),
});

export const listDocumentsQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export const deleteDocumentParams = z.object({
  externalId: z.string().min(1),
});

export const searchBody = z.object({
  query: z.string().min(1).max(2000),
  topK: z.coerce.number().int().positive().max(20).default(5),
});

/**
 * The public shape of a document. `tenantId` is deliberately absent — the
 * caller already knows which tenant it is, and keeping it out of the contract
 * means no future key type can accidentally expose it.
 */
export const documentResponse = z.object({
  id: z.string(),
  externalId: z.string(),
  title: z.string().nullable(),
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const searchResultResponse = z.object({
  documentId: z.string(),
  externalId: z.string(),
  title: z.string().nullable(),
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()),
});

export const errorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
