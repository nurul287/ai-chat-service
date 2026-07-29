import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Document } from "../db/schema";
import { retrieve } from "../retrieval/retrieve";
import { deleteDocument, listDocuments, upsertDocument } from "./documents.service";
import {
  deleteDocumentParams,
  documentResponse,
  errorResponse,
  listDocumentsQuery,
  searchBody,
  searchResultResponse,
  upsertDocumentBody,
} from "./documents.schema";

/** Explicit mapping rather than relying on Zod stripping unknown keys — the
 *  omission of tenantId is a contract decision, not a serializer side effect. */
function toPublicDocument(doc: Document) {
  return {
    id: doc.id,
    externalId: doc.externalId,
    title: doc.title,
    content: doc.content,
    metadata: (doc.metadata ?? {}) as Record<string, unknown>,
    createdAt: toIso(doc.createdAt),
    updatedAt: toIso(doc.updatedAt),
  };
}

/**
 * Postgres hands timestamptz back as `2026-07-29 09:46:57.946863+00`, which is
 * not ISO-8601 — V8 parses it, but a strict consumer (Go's time.RFC3339,
 * Python's fromisoformat before 3.11) does not. Timestamps are part of the
 * published contract, so they are normalised here rather than leaking the
 * driver's wire format to every caller.
 */
function toIso(timestamp: string): string {
  return new Date(timestamp).toISOString();
}

const documentsRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.put(
    "/documents",
    {
      schema: {
        tags: ["Documents"],
        summary: "Create or replace a document",
        description:
          "Upserts on (tenant, externalId). The document is chunked and embedded synchronously, so it is searchable as soon as this call returns.",
        security: [{ bearerAuth: [] }],
        body: upsertDocumentBody,
        response: {
          200: z.object({ data: documentResponse }),
          400: errorResponse,
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const doc = await upsertDocument(request.tenant!.id, request.body);
      return reply.code(200).send({ data: toPublicDocument(doc) });
    },
  );

  app.get(
    "/documents",
    {
      schema: {
        tags: ["Documents"],
        summary: "List this tenant's documents",
        security: [{ bearerAuth: [] }],
        querystring: listDocumentsQuery,
        response: {
          200: z.object({
            data: z.array(documentResponse),
            meta: z.object({
              page: z.number(),
              limit: z.number(),
              total: z.number(),
            }),
          }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { page, limit } = request.query;
      const { data, total } = await listDocuments(request.tenant!.id, page, limit);
      return reply.code(200).send({
        data: data.map(toPublicDocument),
        meta: { page, limit, total },
      });
    },
  );

  app.delete(
    "/documents/:externalId",
    {
      schema: {
        tags: ["Documents"],
        summary: "Delete a document",
        security: [{ bearerAuth: [] }],
        params: deleteDocumentParams,
        response: {
          200: z.object({ data: z.object({ deleted: z.boolean() }) }),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const deleted = await deleteDocument(request.tenant!.id, request.params.externalId);
      if (!deleted) {
        return reply
          .code(404)
          .send({ error: { code: "not_found", message: "Document not found" } });
      }
      return reply.code(200).send({ data: { deleted: true } });
    },
  );

  app.post(
    "/search",
    {
      schema: {
        tags: ["Search"],
        summary: "Hybrid search over this tenant's documents",
        description:
          "Fuses a pgvector cosine-similarity leg and a Postgres full-text leg with Reciprocal Rank Fusion. Results are always scoped to the calling tenant.",
        security: [{ bearerAuth: [] }],
        body: searchBody,
        response: {
          200: z.object({ data: z.array(searchResultResponse) }),
          400: errorResponse,
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const results = await retrieve(request.tenant!.id, request.body.query, request.body.topK);
      return reply.code(200).send({
        data: results.map((r) => ({
          documentId: r.documentId,
          externalId: r.externalId,
          title: r.title,
          content: r.content,
          metadata: (r.metadata ?? {}) as Record<string, unknown>,
        })),
      });
    },
  );
};

export default documentsRoutes;
