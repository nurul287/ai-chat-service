import { and, desc, eq, isNull } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { db } from "../db";
import { apiKeys } from "../db/schema";
import { errorResponse } from "../documents/documents.schema";
import { requireDashboardTenant } from "../plugins/dashboard-auth";
import { issueApiKey, setAllowedOrigins } from "../tenants/tenants.service";
import { mintPublishableKeyResponse, setOriginsBody, widgetConfigResponse } from "./dashboard.schema";

/**
 * The most recent non-revoked publishable key's prefix, or null if none
 * has been minted yet. Only the prefix — the raw key is hashed at rest
 * and shown exactly once, at POST /widget/publishable-key.
 */
async function currentPublishableKeyPrefix(tenantId: string): Promise<string | null> {
  const [row] = await db
    .select({ keyPrefix: apiKeys.keyPrefix })
    .from(apiKeys)
    .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.kind, "publishable"), isNull(apiKeys.revokedAt)))
    .orderBy(desc(apiKeys.createdAt))
    .limit(1);
  return row?.keyPrefix ?? null;
}

const dashboardWidgetRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/widget",
    {
      preHandler: requireDashboardTenant,
      schema: {
        operationId: "getDashboardWidgetConfig",
        tags: ["Dashboard"],
        summary: "This tenant's widget configuration",
        security: [{ bearerAuth: [] }],
        response: { 200: z.object({ data: widgetConfigResponse }), 401: errorResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const publishableKeyPrefix = await currentPublishableKeyPrefix(request.tenant!.id);
      return reply.code(200).send({
        data: {
          allowedOrigins: request.tenant!.allowedOrigins,
          publishableKeyPrefix,
          hasPublishableKey: publishableKeyPrefix !== null,
        },
      });
    },
  );

  app.put(
    "/widget/origins",
    {
      preHandler: requireDashboardTenant,
      schema: {
        operationId: "setDashboardWidgetOrigins",
        tags: ["Dashboard"],
        summary: "Replace this tenant's allowed widget origins",
        security: [{ bearerAuth: [] }],
        body: setOriginsBody,
        response: { 200: z.object({ data: z.object({ allowedOrigins: z.array(z.string()) }) }), 400: errorResponse, 401: errorResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      await setAllowedOrigins(request.tenant!.id, request.body.origins);
      return reply.code(200).send({ data: { allowedOrigins: request.body.origins } });
    },
  );

  app.post(
    "/widget/publishable-key",
    {
      preHandler: requireDashboardTenant,
      schema: {
        operationId: "mintDashboardPublishableKey",
        tags: ["Dashboard"],
        summary: "Mint (or re-mint) this tenant's publishable widget key",
        description:
          "A publishable key is hashed at rest exactly like a secret key, so a lost one cannot " +
          "be retrieved — this always mints a fresh one. The old one (if any) keeps working " +
          "until separately revoked; this route does not revoke it.",
        security: [{ bearerAuth: [] }],
        response: { 200: z.object({ data: mintPublishableKeyResponse }), 401: errorResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { plaintext, prefix } = await issueApiKey(request.tenant!.id, "widget", "publishable");
      return reply.code(200).send({ data: { plaintext, prefix } });
    },
  );
};

export default dashboardWidgetRoutes;
