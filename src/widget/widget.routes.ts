import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { errorResponse } from "../documents/documents.schema";
import { widgetSessionResponse } from "./widget.schema";

const widgetRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/session",
    {
      schema: {
        operationId: "startWidgetSession",
        tags: ["Widget"],
        summary: "Mint a new visitor session for the embeddable widget",
        description:
          "Called once by the widget on first load. Nothing is persisted here — the " +
          "returned id only becomes meaningful once used as externalUserId in a real chat turn.",
        security: [{ bearerAuth: [] }],
        response: { 200: widgetSessionResponse, 401: errorResponse },
      },
    },
    async (_request, reply) => {
      return reply.code(200).send({ externalUserId: randomUUID() });
    },
  );
};

export default widgetRoutes;
