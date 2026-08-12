import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { chatBody } from "../chat/chat.schema";
import { streamChatResponse } from "../chat/stream-chat-response";
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

  app.post(
    "/chat",
    {
      schema: {
        operationId: "sendWidgetChat",
        tags: ["Widget"],
        summary: "Send a message from the embeddable widget and receive a streamed reply",
        description:
          "Identical wire contract to POST /v1/chat, authenticated by a publishable key " +
          "instead of a secret key, and restricted to the tenant's allowed origins. See " +
          "docs/errors.md for the pre-stream vs mid-stream error split.",
        security: [{ bearerAuth: [] }],
        body: chatBody,
        response: { 400: errorResponse, 401: errorResponse, 404: errorResponse },
      },
      sse: "only",
    },
    async (request, reply) => {
      const { externalUserId, conversationId, message } = request.body;
      await streamChatResponse(reply, {
        tenantId: request.tenant!.id,
        externalUserId,
        conversationId: conversationId ?? null,
        message,
      });
    },
  );
};

export default widgetRoutes;
