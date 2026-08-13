import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { errorResponse } from "../documents/documents.schema";
import { requireDashboardTenant } from "../plugins/dashboard-auth";
import { usageQuery, usageResponse } from "./dashboard.schema";
import { getUsageSummary } from "./usage.service";

const dashboardUsageRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/usage",
    {
      preHandler: requireDashboardTenant,
      schema: {
        operationId: "getDashboardUsage",
        tags: ["Dashboard"],
        summary: "Messages and token usage over time for this tenant",
        security: [{ bearerAuth: [] }],
        querystring: usageQuery,
        response: { 200: z.object({ data: usageResponse }), 401: errorResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const summary = await getUsageSummary(request.tenant!.id, request.query.days);
      return reply.code(200).send({ data: summary });
    },
  );
};

export default dashboardUsageRoutes;
