import { z } from "zod";

export const chatBody = z.object({
  externalUserId: z
    .string()
    .min(1)
    .describe("Your own identifier for the end user having this conversation."),
  conversationId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe("Omit or send null to start a new conversation thread."),
  message: z.string().min(1).max(4000),
});

export const listConversationsQuery = z.object({
  externalUserId: z
    .string()
    .min(1)
    .describe("Required — this endpoint always answers for exactly one end user."),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export const conversationParams = z.object({
  id: z.string().uuid(),
});

export const listMessagesQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export const conversationResponse = z.object({
  id: z.string(),
  externalUserId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const messageResponse = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  createdAt: z.string(),
});
