import { tool } from "ai";
import { z } from "zod";
import { retrieve } from "../../retrieval/retrieve";

const inputSchema = z.object({
  query: z.string().min(1).describe("What to search for in the tenant's knowledge base."),
  topK: z
    .number()
    .int()
    .positive()
    .max(10)
    .optional()
    .describe("How many results to return. Defaults to 5."),
});

/**
 * A factory, not a singleton: `tenantId` is closed over at call time from the
 * authenticated request, never a field on `inputSchema` the model could set
 * itself — the same invariant every repository function has held since
 * Sprint 1.
 */
export function searchKnowledgeTool(tenantId: string) {
  return tool({
    description:
      "Search this tenant's knowledge base for documents relevant to a query. Always cite what you find.",
    inputSchema,
    execute: async ({ query, topK }) => retrieve(tenantId, query, topK ?? 5, { mode: "hybrid+rerank" }),
  });
}
