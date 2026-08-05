import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { errorResponse } from "../documents/documents.schema";
import { listPublicTools, registerTool, revokeTool, ToolNameConflictError } from "./tenant-tools.service";
import { registerToolBody, registerToolResponse, toolNameParams, toolResponse } from "./tools.schema";

function toIso(timestamp: string): string {
  return new Date(timestamp).toISOString();
}

const toolsRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/tools",
    {
      schema: {
        operationId: "registerTool",
        tags: ["Tools"],
        summary: "Register a custom tool the chat model can call mid-conversation",
        description:
          "The response includes an HMAC secret shown exactly once — store it immediately. " +
          "It signs every request this service sends to your endpoint. See docs/custom-tools.md.",
        security: [{ bearerAuth: [] }],
        body: registerToolBody,
        response: { 200: z.object({ data: registerToolResponse }), 400: errorResponse, 401: errorResponse },
      },
    },
    async (request, reply) => {
      try {
        const tool = await registerTool(request.tenant!.id, request.body);
        return reply.code(200).send({
          data: {
            id: tool.id,
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            endpointUrl: tool.endpointUrl,
            hmacSecret: tool.hmacSecret,
            createdAt: toIso(tool.createdAt),
          },
        });
      } catch (err) {
        if (err instanceof ToolNameConflictError) {
          return reply.code(400).send({ error: { code: "invalid_request", message: err.message } });
        }
        throw err;
      }
    },
  );

  app.get(
    "/tools",
    {
      schema: {
        operationId: "listTools",
        tags: ["Tools"],
        summary: "List this tenant's registered tools",
        security: [{ bearerAuth: [] }],
        response: { 200: z.object({ data: z.array(toolResponse) }), 401: errorResponse },
      },
    },
    async (request, reply) => {
      const tools = await listPublicTools(request.tenant!.id);
      return reply.code(200).send({
        data: tools.map((t) => ({ ...t, createdAt: toIso(t.createdAt) })),
      });
    },
  );

  app.delete(
    "/tools/:name",
    {
      schema: {
        operationId: "revokeTool",
        tags: ["Tools"],
        summary: "Revoke a registered tool",
        security: [{ bearerAuth: [] }],
        params: toolNameParams,
        response: {
          200: z.object({ data: z.object({ revoked: z.boolean() }) }),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const revoked = await revokeTool(request.tenant!.id, request.params.name);
      if (!revoked) {
        return reply.code(404).send({ error: { code: "not_found", message: "Tool not found" } });
      }
      return reply.code(200).send({ data: { revoked: true } });
    },
  );
};

export default toolsRoutes;
