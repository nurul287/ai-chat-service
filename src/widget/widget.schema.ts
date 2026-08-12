import { z } from "zod";

export const widgetSessionResponse = z.object({
  externalUserId: z.string(),
});

export const widgetConversationParams = z.object({
  id: z.string().uuid(),
});

export const widgetMessagesQuery = z.object({
  externalUserId: z.string().min(1),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
});
