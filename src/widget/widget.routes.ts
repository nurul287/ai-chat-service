import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Message } from "../db/schema";
import { chatBody, messageResponse } from "../chat/chat.schema";
import { getConversation, listMessages } from "../chat/conversations.service";
import { streamChatResponse } from "../chat/stream-chat-response";
import { errorResponse } from "../documents/documents.schema";
import { widgetConversationParams, widgetMessagesQuery, widgetSessionResponse } from "./widget.schema";

function toPublicMessage(m: Message) {
  return { id: m.id, role: m.role, content: m.content, createdAt: m.createdAt };
}

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

  app.get(
    "/conversations/:id/messages",
    {
      schema: {
        operationId: "listWidgetConversationMessages",
        tags: ["Widget"],
        summary: "Full message log for one conversation, for the widget to restore history on page load",
        description:
          "The untrusted-browser equivalent of GET /v1/conversations/:id/messages. That route " +
          "trusts its caller (a tenant's own backend) to only ask about its own users, so it " +
          "checks tenant ownership alone. This route's caller is any browser holding a valid " +
          "publishable key, so ownership is checked three ways instead: tenant, externalUserId, " +
          "and conversation id — a mismatch on any of them returns the same 404.",
        security: [{ bearerAuth: [] }],
        params: widgetConversationParams,
        querystring: widgetMessagesQuery,
        response: {
          200: z.object({
            data: z.array(messageResponse),
            meta: z.object({ page: z.number(), limit: z.number(), total: z.number() }),
          }),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { externalUserId, page, limit } = request.query;
      const conversation = await getConversation(request.tenant!.id, externalUserId, request.params.id);
      if (!conversation) {
        return reply
          .code(404)
          .send({ error: { code: "not_found", message: "Conversation not found" } });
      }

      const { data, total } = await listMessages(conversation.id, page, limit);
      return reply.code(200).send({ data: data.map(toPublicMessage), meta: { page, limit, total } });
    },
  );
};

export default widgetRoutes;
