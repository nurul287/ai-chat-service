import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { toPublicDocument } from "../documents/documents.routes";
import {
  deleteDocumentParams,
  documentResponse,
  errorResponse,
  listDocumentsQuery,
  upsertDocumentBody,
} from "../documents/documents.schema";
import { deleteDocument, listDocuments, upsertDocument } from "../documents/documents.service";
import { requireDashboardTenant } from "../plugins/dashboard-auth";

/**
 * Thin wrappers over documents.service.ts — identical behavior to
 * /v1/documents, just authenticated by a dashboard session instead of a
 * secret key. toPublicDocument is imported rather than reimplemented so
 * the two response shapes cannot drift apart.
 */
const dashboardDocumentsRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.put(
    "/documents",
    {
      preHandler: requireDashboardTenant,
      schema: {
        operationId: "dashboardUpsertDocument",
        tags: ["Dashboard"],
        summary: "Create or replace a document (dashboard session auth)",
        security: [{ bearerAuth: [] }],
        body: upsertDocumentBody,
        response: { 200: z.object({ data: documentResponse }), 400: errorResponse, 401: errorResponse, 404: errorResponse },
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
      preHandler: requireDashboardTenant,
      schema: {
        operationId: "dashboardListDocuments",
        tags: ["Dashboard"],
        summary: "List this tenant's documents (dashboard session auth)",
        security: [{ bearerAuth: [] }],
        querystring: listDocumentsQuery,
        response: {
          200: z.object({
            data: z.array(documentResponse),
            meta: z.object({ page: z.number(), limit: z.number(), total: z.number() }),
          }),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { page, limit } = request.query;
      const { data, total } = await listDocuments(request.tenant!.id, page, limit);
      return reply.code(200).send({ data: data.map(toPublicDocument), meta: { page, limit, total } });
    },
  );

  app.delete(
    "/documents/:externalId",
    {
      preHandler: requireDashboardTenant,
      schema: {
        operationId: "dashboardDeleteDocument",
        tags: ["Dashboard"],
        summary: "Delete a document (dashboard session auth)",
        security: [{ bearerAuth: [] }],
        params: deleteDocumentParams,
        response: { 200: z.object({ data: z.object({ deleted: z.boolean() }) }), 401: errorResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const deleted = await deleteDocument(request.tenant!.id, request.params.externalId);
      if (!deleted) {
        return reply.code(404).send({ error: { code: "not_found", message: "Document not found" } });
      }
      return reply.code(200).send({ data: { deleted: true } });
    },
  );
};

export default dashboardDocumentsRoutes;
