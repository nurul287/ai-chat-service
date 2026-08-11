import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { errorResponse } from "../documents/documents.schema";
import type { Conversation, Message } from "../db/schema";
import {
  chatBody,
  conversationParams,
  conversationResponse,
  listConversationsQuery,
  listMessagesQuery,
  messageResponse,
} from "./chat.schema";
import { ConversationNotFoundError, runChat, type ChatWireEvent } from "./chat.service";
import { getConversationByIdForTenant, listConversations, listMessages } from "./conversations.service";

function toPublicConversation(c: Conversation) {
  return { id: c.id, externalUserId: c.externalUserId, createdAt: c.createdAt, updatedAt: c.updatedAt };
}

function toPublicMessage(m: Message) {
  return { id: m.id, role: m.role, content: m.content, createdAt: m.createdAt };
}

function toSSEFrame(event: ChatWireEvent) {
  return { event: event.event, data: event.data };
}

const chatRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/chat",
    {
      schema: {
        operationId: "sendChat",
        tags: ["Chat"],
        summary: "Send a message and receive a streamed reply",
        description:
          "Streams the reply over Server-Sent Events (token, sources, tool_call, done, error). " +
          "`tool_call` carries a custom tool's name, arguments and raw result — see docs/custom-tools.md. " +
          "A conversationId that does not belong to the caller returns a plain 404 " +
          "BEFORE the stream starts. A failure mid-stream is an `error` SSE event " +
          "instead, since the HTTP status can no longer change once streaming has " +
          "begun — see docs/errors.md.",
        security: [{ bearerAuth: [] }],
        body: chatBody,
        response: { 400: errorResponse, 401: errorResponse, 404: errorResponse },
      },
      sse: "only",
    },
    async (request, reply) => {
      const { externalUserId, conversationId, message } = request.body;
      const generator = runChat({
        tenantId: request.tenant!.id,
        externalUserId,
        conversationId: conversationId ?? null,
        message,
      });

      let first: IteratorResult<ChatWireEvent>;
      try {
        first = await generator.next();
      } catch (err) {
        if (err instanceof ConversationNotFoundError) {
          return reply
            .code(404)
            .send({ error: { code: "not_found", message: "Conversation not found" } });
        }
        throw err;
      }

      async function* toSSE() {
        if (!first.done) yield toSSEFrame(first.value);
        for await (const event of generator) yield toSSEFrame(event);
      }

      await reply.sse.send(toSSE());
    },
  );

  app.get(
    "/conversations",
    {
      schema: {
        operationId: "listConversations",
        tags: ["Chat"],
        summary: "List this tenant's conversation threads for one external user",
        security: [{ bearerAuth: [] }],
        querystring: listConversationsQuery,
        response: {
          200: z.object({
            data: z.array(conversationResponse),
            meta: z.object({ page: z.number(), limit: z.number(), total: z.number() }),
          }),
          400: errorResponse,
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { externalUserId, page, limit } = request.query;
      const { data, total } = await listConversations(request.tenant!.id, externalUserId, page, limit);
      return reply
        .code(200)
        .send({ data: data.map(toPublicConversation), meta: { page, limit, total } });
    },
  );

  app.get(
    "/conversations/:id/messages",
    {
      schema: {
        operationId: "listConversationMessages",
        tags: ["Chat"],
        summary: "Full message log for one conversation, oldest first",
        security: [{ bearerAuth: [] }],
        params: conversationParams,
        querystring: listMessagesQuery,
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
      const conversation = await getConversationByIdForTenant(request.tenant!.id, request.params.id);
      if (!conversation) {
        return reply
          .code(404)
          .send({ error: { code: "not_found", message: "Conversation not found" } });
      }

      const { page, limit } = request.query;
      const { data, total } = await listMessages(conversation.id, page, limit);
      return reply.code(200).send({ data: data.map(toPublicMessage), meta: { page, limit, total } });
    },
  );
};

export default chatRoutes;
