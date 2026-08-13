import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { errorResponse } from "../documents/documents.schema";
import { requireDashboardTenant } from "../plugins/dashboard-auth";
import { issueApiKey, listApiKeys, revokeApiKey } from "../tenants/tenants.service";
import { apiKeyResponse, createKeyBody, createKeyResponse, revokeKeyParams } from "./dashboard.schema";

function toIso(timestamp: string | null): string | null {
  return timestamp ? new Date(timestamp).toISOString() : null;
}

const dashboardKeysRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/keys",
    {
      preHandler: requireDashboardTenant,
      schema: {
        operationId: "listDashboardKeys",
        tags: ["Dashboard"],
        summary: "List this tenant's secret keys",
        security: [{ bearerAuth: [] }],
        response: { 200: z.object({ data: z.array(apiKeyResponse) }), 401: errorResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const keys = await listApiKeys(request.tenant!.id);
      return reply.code(200).send({
        data: keys.map((k) => ({
          id: k.id,
          name: k.name,
          keyPrefix: k.keyPrefix.slice("sk_live_".length),
          lastUsedAt: toIso(k.lastUsedAt),
          revokedAt: toIso(k.revokedAt),
          createdAt: toIso(k.createdAt)!,
        })),
      });
    },
  );

  app.post(
    "/keys",
    {
      preHandler: requireDashboardTenant,
      schema: {
        operationId: "createDashboardKey",
        tags: ["Dashboard"],
        summary: "Issue a new named secret key",
        security: [{ bearerAuth: [] }],
        body: createKeyBody,
        response: { 200: z.object({ data: createKeyResponse }), 400: errorResponse, 401: errorResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      // issueApiKey only returns { plaintext, prefix } — not the row's id —
      // so the created row is looked up by its (unique) prefix afterwards.
      const { plaintext, prefix } = await issueApiKey(request.tenant!.id, request.body.name);
      const [created] = (await listApiKeys(request.tenant!.id)).filter((k) => k.keyPrefix === prefix);
      return reply
        .code(200)
        .send({ data: { id: created!.id, name: request.body.name, keyPrefix: prefix, plaintext } });
    },
  );

  app.delete(
    "/keys/:id",
    {
      preHandler: requireDashboardTenant,
      schema: {
        operationId: "revokeDashboardKey",
        tags: ["Dashboard"],
        summary: "Revoke a secret key",
        security: [{ bearerAuth: [] }],
        params: revokeKeyParams,
        response: { 200: z.object({ data: z.object({ revoked: z.boolean() }) }), 401: errorResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const revoked = await revokeApiKey(request.tenant!.id, request.params.id);
      if (!revoked) {
        return reply.code(404).send({ error: { code: "not_found", message: "Key not found" } });
      }
      return reply.code(200).send({ data: { revoked: true } });
    },
  );
};

export default dashboardKeysRoutes;
